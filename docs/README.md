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

GitLab runs the application tests, builds the docs, and checks generated links on merge requests,
the default branch and stable `vX.Y.Z` tags. Deployment runs after successful checks on release tags,
or when docs/build inputs change on the default branch. Release tags must match `package.json` and
the version must have a changelog entry. Keep release tags protected (`v*`).

The site is hosted on GitLab Pages. The `docs:pages` job publishes the tested `docs/dist/public`
artifact with `pages.publish`, never the application checkout or local config. It needs no token
or CI variable. GitLab deploys the files after the job (`pages:deploy` in the pipeline), and the
site can take a few minutes to update after the pipeline completes. On GitLab.com the site is
public. A missing page gets the generated `404.html`, whose links are right for a miss directly
under the site root.

GitLab assigns the address on the first deployment; **Deploy > Pages** shows it. With
**Use unique domain** turned on, the default for new projects, the site is at the root of its own
`gitlab.io` domain; with it turned off, the site is under `zamazingo99.gitlab.io/dulger/`.
Until the address is linked from the README, the package `homepage` is the GitLab project.

To check a deployment, open `version.json` on the site: `revision` is the commit it was built from.
`npm run --prefix docs verify-deployment -- <site URL>` waits for the live `version.json` to match a
local build of the same commit (the source hash, and the revision when the build has one).

To roll back, revert the responsible documentation commit on the default branch; its pipeline
deploys the result. Re-running the Pages job of an older default-branch pipeline is no rollback:
GitLab refuses to replace a deployment from a newer pipeline with it.

The site keeps the plain reading layout and the routes of the original site.
