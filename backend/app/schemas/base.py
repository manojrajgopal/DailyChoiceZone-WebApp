"""Schema conventions shared by every response."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


def to_camel(value: str) -> str:
    head, *rest = value.split("_")
    return head + "".join(word.capitalize() for word in rest)


class CamelModel(BaseModel):
    """
    Serialises `original_price` as `originalPrice`.

    The frontend's TypeScript types are already camelCase and already match the
    demo data's shape. Emitting that shape directly means the HTTP adapters
    are a `fetch` and nothing else — no mapping layer to write, and none to
    forget to update when a field is added.

    `populate_by_name` keeps the Python names usable for input too, so internal
    construction does not have to speak camelCase.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


class ORMModel(CamelModel):
    """A CamelModel built from SQLAlchemy rows."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )
