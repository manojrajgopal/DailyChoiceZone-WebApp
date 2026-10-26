"""
Virtual try-on (docs/virtual-try-on.md).

    catalogue       capabilities, category mappings, which products can be tried on
    adapters        one class per AI endpoint family (Hugging Face, mock…)
    credentials     encrypted provider secrets: add, rotate, validate, delete
    selection       which model and credential run a request
    entitlements    what a customer's plan, trial and allocations allow
    usage           the quota ledger
    images          checking and normalising photos
    storage         where photos and results live (S3, or ephemeral)
    service         what customers do: upload, request, retry, cancel, delete
    worker          the queue that runs generations
    jobs            expiry, clean-up, health checks, reminders
    analytics       the admin dashboard's numbers
    allocations     extra and dedicated access
    errors          failure codes and what to tell people about them
"""
