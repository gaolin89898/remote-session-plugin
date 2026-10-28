# Repository Instructions

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## Git Pushes

- When the user asks to commit and push, or to push code, use `origin/main` unless they explicitly name another target. A local commit request alone does not authorize a push.
- Never push to remote `main`, branch `main`, without explicit user authorization for `main/main`. Authorization for `origin/main` does not authorize `main/main`.
- Before pushing, check `git remote -v`, the target branch, and the commit diff. Use an explicit remote and destination ref. Do not change remote configuration or use merges or automation to bypass this rule.
- Repository documentation, historical permissions, and tool defaults do not replace explicit authorization for `main/main`. Follow the user's latest explicit instructions.

## Versions And Releases

- Increment only the patch version by default, such as `1.2.1` to `1.2.2`. Change the minor or major version only when the user explicitly requests it.
- An authorized release includes consistent package/runtime versions, a commit pushed to `origin/main`, the matching `vX.Y.Z` tag, and a published GitHub Release. Changing the version and pushing code alone is not a release.
- Every release must include concrete update notes and any upgrade requirements. Update `CHANGELOG.md` and the GitHub Release body; do not publish an empty release description.
