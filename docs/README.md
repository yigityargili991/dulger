# Documentation website

The website is generated from the root `README.md`, `CHANGELOG.md` and package version.
Edit those files alongside application changes; there is no second copy of the prose to update.
This publishes maintained documentation automatically; it does not invent documentation from code.

```sh
npm ci --prefix docs
npm run --prefix docs build
npm test --prefix docs
python3 -m http.server 4173 --directory docs/dist/public
```

`build.mjs` maps README sections to pages while keeping existing public URLs. New or renamed
top-level sections must be mapped there; otherwise the build fails instead of dropping content.
Cross-page README anchors are rewritten. Every page shows the package version; `/version.json`
identifies the exact source build. The generated `docs/dist/` directory is ignored by Git.

## CI and deployment

GitLab runs the application tests, builds the docs, and checks generated links on merge requests,
the default branch and stable `vX.Y.Z` tags. Deployment runs after successful checks on release tags,
or when docs/build inputs change on the default branch. Release tags must match `package.json` and
the version must have a changelog entry. Keep release tags protected (`v*`).

The deploy job uploads only the tested artifact, never the application checkout or local config.
The existing Railway project and production service IDs are in `.gitlab-ci.yml`. Caddy serves the
static files, including a real 404 page. Jobs serialize through `docs-production`; GitLab's
**Prevent outdated deployment jobs** setting must remain enabled. The final job polls the live
source hash and revision, so a successful build alone is not reported as a successful deployment.

GitLab needs `RAILWAY_TOKEN`: a production-environment project token for `dulger-site`, stored as a
masked, protected CI variable scoped to `docs-production`. Never put this token in repository files.
Use a fresh environment-scoped token when rotating it. No npm publishing credential is needed.

To roll back, redeploy a previous successful deployment in Railway. To retain the fix across future
CI runs, revert the responsible documentation commit as well. A manual pipeline on the default
branch can rebuild and deploy the current documentation.

The former site was uploaded via Railway CLI with no connected repository. Its plain reading
layout and existing routes are preserved here; the site no longer depends on that missing checkout.
