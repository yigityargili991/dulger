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
Cross-page README anchors are rewritten. Links and the stylesheet are relative to each page, so the
site works at a domain root or under a path. Every page shows the package version; `version.json`
at the site root identifies the exact source build. The generated `docs/dist/` directory is ignored
by Git.

## CI and deployment

GitHub Actions (`.github/workflows/ci.yml`) runs the application tests (`test`) and builds the docs
and checks generated links (`docs`) on pull requests, pushes to `master` and stable `vX.Y.Z` tags.
Release tags must match `package.json` and the version must have a changelog entry.

The site is hosted on GitHub Pages at https://yigityargili991.github.io/dulger/. Every push to
`master` deploys it once both jobs pass: the `docs` job uploads the tested `docs/dist/public` as the
Pages artifact, never the application checkout or local config, and the `deploy` job publishes it.
Pull requests and tags deploy nothing; a release pushes `master` with its tag. Deployments run one
at a time. No secret or variable is needed: only the `deploy` job's own token may write to Pages.
The site can take a few minutes to update after the run completes. A missing page gets the
generated `404.html`, whose links are right for a miss directly under the site root.

Pages must use the **GitHub Actions** source (**Settings > Pages > Build and deployment**); it was
set through the API when the repository was created. **Settings > Pages** links to the run that
last deployed the site.

To check a deployment, open `version.json` on the site: `revision` is the commit it was built from.
`npm run --prefix docs verify-deployment -- https://yigityargili991.github.io/dulger/` waits for
the live `version.json` to match a local build of the same commit (the source hash, and the
revision when the build has one).

To roll back, revert the responsible documentation commit on `master` and push; its run deploys
the result. Re-running an older run's `deploy` job is no documented rollback, and the Pages artifact
it would deploy is kept for one day only.

The site keeps the plain reading layout and the routes of the original site.
