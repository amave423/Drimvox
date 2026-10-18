# Publishing a project on GitHub

A project folder becomes a GitHub repository from Artel, without the user installing `gh` or typing a token.

## Signing in
- GitHub's device flow with Artel's OAuth app (client ID `Ov23liuac4Ai8HSL86BH`, registered once by the author; the
  ID is public, there is no client secret). Scope `repo`: creating and pushing private repositories needs it.
- Artel asks GitHub for a code, shows it with the link github.com/login/device and waits while the user enters it.
  Refused or expired: the page says so and offers to start again.
- The token is kept encrypted next to the settings (like the proxy address). It never reaches the interface, logs
  or git's arguments. "Disconnect" forgets it.

## Publishing
- Only a project with git and no `origin` remote. Artel shows the name (the folder's by default) and whether the
  repository is private (by default it is), and asks to confirm before creating anything.
- Artel creates the repository through the API, adds it as `origin` and pushes the current branch with `-u`.
  The token goes to git through `GIT_CONFIG_*` environment variables as an `Authorization` header for GitHub's host.
- A name already taken, a token GitHub no longer accepts, a push that failed: each is said in plain words.
- A project with `origin` already set gets "Push to GitHub" instead: the current branch goes to its remote.
- Only commits are pushed: changes not yet accepted stay in Artel.
