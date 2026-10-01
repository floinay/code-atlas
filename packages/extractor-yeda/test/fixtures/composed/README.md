# Composed

A tiny Yeda-style repository where a feature gets its dependencies from the service that hosts it.
`features/mail` defines the feature and its adapters; `apps/backend` binds them together. The
extractor tests read it with and without `apps/backend` listed in the domains config.
