"""Customer segmentation: metrics, the rule engine, saved segments and the job. See docs/customer-segmentation.md."""

# Importing the metrics module registers the change hook that marks customers dirty.
from app.services.segments import metrics as _metrics  # noqa: E402,F401
