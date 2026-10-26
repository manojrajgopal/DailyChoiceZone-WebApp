"""
Hugging Face Spaces, through `gradio_client`.

The proven call is OOTDiffusion's half-body endpoint, exactly as the earlier
stand-alone try-on service made it:

    Client("levihsu/OOTDiffusion", hf_token=…).predict(
        vton_img=…, garm_img=…, n_samples=1, n_steps=20, image_scale=2, seed=-1,
        api_name="/process_hd")

which answers a gallery — a list of `{"image": <downloaded file>, …}` — whose
first image is the result. The full-body endpoint (`/process_dc`) takes a
`category` too and is registered for lower-body and dress try-ons, disabled
until verified.

Differences from that service, on purpose:

- every call has a deadline (`Client.submit` + `job.result(timeout)`), and a
  call that runs out is cancelled;
- inputs and downloaded results live in a per-call working folder that is
  removed when the call ends, success or not;
- errors are classified by what they say (credentials, GPU quota, timeouts,
  a sleeping Space…), and only a credential problem counts against the
  credential.
"""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from app.services.try_on.adapters.base import GenerationInput, GenerationOutput, HealthResult, TryOnAdapter
from app.services.try_on import network
from app.services.try_on.errors import ProviderFailure

logger = logging.getLogger(__name__)

# Provider hosts over IPv4 first, where IPv6 is broken (see network.py).
network.install()

WHOAMI_URL = "https://huggingface.co/api/whoami-v2"

_CLIENTS: "OrderedDict[tuple, object]" = OrderedDict()
_CLIENTS_LOCK = threading.Lock()
_MAX_CLIENTS = 32


def _workroot() -> Path:
    from app.services.try_on.storage import ephemeral_dir

    root = ephemeral_dir() / "work"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _client_for(space: str, secret: Optional[str]):
    """One gradio Client per (Space, credential), reused: creating one fetches the Space's config."""
    from gradio_client import Client

    tag = hashlib.sha256((secret or "").encode()).hexdigest()[:16]
    key = (space, tag)
    with _CLIENTS_LOCK:
        client = _CLIENTS.get(key)
        if client is not None:
            _CLIENTS.move_to_end(key)
            return client
    client = Client(space, hf_token=secret or None, verbose=False, download_files=str(_workroot() / "downloads"),
                    analytics_enabled=False)
    with _CLIENTS_LOCK:
        _CLIENTS[key] = client
        while len(_CLIENTS) > _MAX_CLIENTS:
            _CLIENTS.popitem(last=False)
    return client


def forget_clients() -> None:
    """Drop cached clients — after a credential is rotated or deleted."""
    with _CLIENTS_LOCK:
        _CLIENTS.clear()


_RETRY_AFTER = re.compile(r"(?:try again|retry) in (\d+):(\d{2}):(\d{2})", re.I)


def classify_message(error: BaseException) -> ProviderFailure:
    text = f"{type(error).__name__}: {error}"
    lower = text.lower()
    if isinstance(error, TimeoutError) or "timed out" in lower or "timeout" in lower:
        return ProviderFailure("timeout", text)
    if ("quota" in lower or "zerogpu" in lower or "rate limit" in lower or "too many requests" in lower
            or " 429" in lower or "gpu task aborted" in lower):
        match = _RETRY_AFTER.search(text)
        retry = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3)) if match else None
        return ProviderFailure("rate_limited", text, retry_after=retry)
    if ("invalid user token" in lower or "invalid token" in lower or "unauthorized" in lower or " 401" in lower
            or "invalid credentials" in lower or "authentication" in lower or " 403" in lower):
        return ProviderFailure("invalid_credentials", text)
    if any(word in lower for word in ("sleeping", "is building", "paused", "runtime_error", "space is not running",
                                      "could not fetch config", " 502", " 503", " 504", "connecterror",
                                      "connection", "name resolution", "websocket", "bad gateway",
                                      "service unavailable")):
        return ProviderFailure("provider_unavailable", text)
    return ProviderFailure("unknown", text)


def _result_path(result) -> Optional[str]:
    """The first image of a gallery answer: [{"image": path}, …], or a bare path."""
    item = result
    if isinstance(item, (list, tuple)) and item:
        item = item[0]
    if isinstance(item, dict):
        item = item.get("image") or item.get("path") or item.get("name")
        if isinstance(item, dict):
            item = item.get("path") or item.get("url")
    return item if isinstance(item, str) and item else None


class _OotdBase(TryOnAdapter):
    provider_kind = "huggingface"
    config_fields = {
        "space": "The Space, as owner/name.",
        "apiName": "The endpoint, e.g. /process_hd.",
        "params": "Extra parameters, e.g. {\"n_steps\": 20, \"image_scale\": 2, \"seed\": -1}.",
    }

    def arguments(self, person, garment, inputs: GenerationInput, config: dict) -> dict:
        params = dict(config.get("params") or {})
        args = {"vton_img": person, "garm_img": garment}
        for name, default in (("n_samples", 1), ("n_steps", 20), ("image_scale", 2), ("seed", -1)):
            args[name] = params.get(name, default)
        return args

    def generate(self, inputs: GenerationInput, *, secret: Optional[str], config: dict,
                 timeout: float) -> GenerationOutput:
        from gradio_client import handle_file

        space = config.get("space") or ""
        api_name = config.get("apiName") or ""
        if not space or not api_name:
            raise ProviderFailure("unknown", "model configuration is missing space or apiName")

        workdir = Path(tempfile.mkdtemp(prefix="call-", dir=str(_workroot())))
        result_path: Optional[Path] = None
        try:
            person, garment = workdir / "person.jpg", workdir / "garment.jpg"
            person.write_bytes(inputs.person)
            garment.write_bytes(inputs.garment)
            try:
                client = _client_for(space, secret)
                job = client.submit(**self.arguments(handle_file(str(person)), handle_file(str(garment)), inputs,
                                                     config), api_name=api_name)
                try:
                    result = job.result(timeout=timeout)
                except TimeoutError:
                    try:
                        job.cancel()
                    except Exception:  # noqa: BLE001 — best effort
                        pass
                    raise
            except ProviderFailure:
                raise
            except BaseException as error:  # noqa: BLE001 — every provider error is classified
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                raise self.classify(error) from None

            found = _result_path(result)
            if not found:
                raise ProviderFailure("bad_provider_response", f"answer had no image ({type(result).__name__})")
            result_path = Path(found)
            try:
                data = result_path.read_bytes()
            except OSError:
                raise ProviderFailure("bad_provider_response", "the result file could not be read") from None
            return GenerationOutput(data=data, content_type="image/png" if data[:4] == b"\x89PNG" else "image/jpeg")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            if result_path is not None:
                # gradio_client downloads into a folder of its own per file.
                try:
                    result_path.unlink(missing_ok=True)
                    if result_path.parent.name != "downloads":
                        shutil.rmtree(result_path.parent, ignore_errors=True)
                except OSError:
                    pass

    def classify(self, error: BaseException) -> ProviderFailure:
        if isinstance(error, ProviderFailure):
            return error
        return classify_message(error)

    def check_credential(self, secret: str, *, config: dict) -> HealthResult:
        """Hugging Face's whoami: confirms the token is valid without spending GPU time."""
        import httpx

        started = time.monotonic()
        try:
            response = httpx.get(WHOAMI_URL, headers={"Authorization": f"Bearer {secret}"}, timeout=10)
        except httpx.HTTPError as error:
            return HealthResult(False, "provider_unavailable", f"could not reach Hugging Face ({type(error).__name__})",
                                int((time.monotonic() - started) * 1000))
        latency = int((time.monotonic() - started) * 1000)
        if response.status_code == 200:
            body = response.json() if "json" in response.headers.get("content-type", "") else {}
            auth = (body.get("auth") or {}).get("accessToken") or {}
            info = {"accountType": body.get("type") or "", "tokenRole": auth.get("role") or ""}
            limit = response.headers.get("x-ratelimit-limit")
            if limit:
                info["rateLimit"] = limit
            return HealthResult(True, "", "token accepted", latency, info)
        if response.status_code in (401, 403):
            return HealthResult(False, "invalid_credentials", f"Hugging Face answered HTTP {response.status_code}", latency)
        if response.status_code == 429:
            return HealthResult(False, "rate_limited", "Hugging Face answered HTTP 429", latency)
        return HealthResult(False, "provider_unavailable", f"Hugging Face answered HTTP {response.status_code}", latency)


class OotdHalfBody(_OotdBase):
    key = "huggingface.ootd_half_body"
    label = "OOTDiffusion — half body (/process_hd)"
    description = "Upper-body garments on a half-body photo. The proven endpoint."
    max_capabilities = ("garment.upper_body",)


class OotdFullBody(_OotdBase):
    key = "huggingface.ootd_full_body"
    label = "OOTDiffusion — full body (/process_dc)"
    description = "Upper, lower and dress garments on a full-body photo. Verify before enabling."
    max_capabilities = ("garment.upper_body", "garment.lower_body", "garment.dress")
    CATEGORIES = {"garment.upper_body": "Upper-body", "garment.lower_body": "Lower-body", "garment.dress": "Dress"}

    def arguments(self, person, garment, inputs: GenerationInput, config: dict) -> dict:
        args = super().arguments(person, garment, inputs, config)
        category = (config.get("categoryValues") or {}).get(inputs.capability) or self.CATEGORIES.get(inputs.capability)
        if not category:
            raise ProviderFailure("unsupported_category", f"no category value for {inputs.capability}")
        return {"vton_img": args["vton_img"], "garm_img": args["garm_img"], "category": category,
                **{k: v for k, v in args.items() if k not in ("vton_img", "garm_img")}}
