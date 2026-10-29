# Release the package

## Prepare the first publication

1. Create or confirm the public repository `https://github.com/tallshort/pi-copy-picker`. The package metadata already targets it.
2. Set `origin` fetch and push URLs to that repository. If the repository changes, update `repository.url`, `homepage`, and `bugs.url` in `package.json` before publishing.
3. Commit the package, lockfile, docs, and workflow on `main`. Push `main`. Keep the working tree clean. Do not commit `node_modules/`. The package publishes `src/` directly.
4. Confirm that your npm account can publish the top-level package `pi-copy-picker`. The package name is not scoped; `tallshort` is the author. Use Node 24 and npm 11.5.1 or newer. Trusted publishing requires at least Node 22.14.0 and npm 11.5.1.
5. Follow the README's isolated install and check procedure. From the checked sandbox copy, use an interactive npm login and publish the first version manually:

```sh
	npm login
	npm publish --access public
```

The human runs these commands. No publication has been performed by this preparation task.
A package must exist before its trusted publisher can be configured. Do not expect OIDC to bootstrap an unpublished package.
The first manual publication does not claim GitHub Actions provenance.

## Configure trusted publishing

After the npm package exists, open its npm settings and add a GitHub Actions trusted publisher.
Use GitHub owner `tallshort`, repository `pi-copy-picker`, and the exact workflow filename `release.yml`.
Leave the environment unset unless you also add that environment to the workflow job.
Use [npm's trusted publisher guide](https://docs.npmjs.com/trusted-publishers/) and the [npm trust reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

The workflow uses a GitHub-hosted runner, Node 24, `id-token: write`, and `npm publish --access public --provenance`.
Provenance requires a public repository and matching `repository.url` metadata.
Do not add `NPM_TOKEN` or other long-lived publication credentials to this workflow.
The workflow rejects prereleases, mismatched package versions, mismatched repository identity, tags outside `main`, and incompatible npm versions.

## Prepare future tags

Use an ordinary local clone with dependencies installed, not the shared checkout.
The release helper requires a real Git root, clean `main`, matching origin and repository metadata, and HEAD equal to remote `main`.
It checks local and remote tag collisions and runs the complete check before any version or tag mutation.
The default only performs preflight checks. It does not fetch, pull, publish, push, or change versions or refs.

```sh
	npm run release -- current
	npm run release -- patch
```

`current` targets the existing package version. It can create the initial `v1.0.0` tag without bumping to `1.0.1`.
After manually publishing 1.0.0, do not push its tag into the publish workflow, because npm rejects duplicate versions.
Use a patch, minor, or major release for the next CI publication.
Update the changelog and commit it before running the helper.

To create local release refs after reviewing the preflight result:

```sh
	npm run release -- patch --execute
```

`--execute` updates the manifest and lockfile, reruns checks, commits the version change, and creates an annotated tag.
For `current`, it only creates the tag. The helper never pushes.
If a check or commit fails after the version change, inspect and resolve the local edits before retrying. There is no automatic rollback.

Review the generated commit and tag, then atomically push `main` and the exact tag. Replace the example tag with the version you prepared:

```sh
	git push --atomic origin main refs/tags/v1.0.1
```

A tag push triggers CI. It does not prove publication succeeded.
Check the workflow result and the registry version before announcing a release.
If CI fails before publication, fix the cause and inspect registry state before deciding whether to retry.
Never overwrite a published version or force-push a release tag.
