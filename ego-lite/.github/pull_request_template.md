## Summary

<!-- What changed, and why is this the smallest useful solution? -->

## Related issue

<!-- Use "Closes #123" when applicable. If there is no issue, briefly explain why. -->

## Changes

<!-- List the important implementation or documentation changes. -->

-

## Verification

<!-- List the checks you ran and their results. Commands run from package/ego-browser unless noted otherwise. -->

```text
npm test
npm run validate:site-skills
```

<!-- Add screenshots or a reproducible ego-browser heredoc for user-visible behavior. Remove this comment if not applicable. -->

## Impact

<!-- Check every affected area. -->

- [ ] Public helper API or behavior
- [ ] Agent skill or instructions
- [ ] Site learning
- [ ] Installation or update flow
- [ ] Build, CI, or release process
- [ ] Documentation only
- [ ] No externally visible impact

<!-- Describe compatibility, migration, or rollout concerns for any affected public surface. Remove this comment if none. -->

## Checklist

- [ ] The PR targets the correct base branch (`dev` for normal changes; only `dev` may target `main`).
- [ ] The change is focused and does not include unrelated cleanup.
- [ ] Tests were added or updated for behavior changes, or the reason they are unnecessary is explained above.
- [ ] Relevant tests and validation commands pass locally.
- [ ] Public helper JSDoc and agent-facing documentation are updated when the helper surface changes.
- [ ] No credentials, tokens, cookies, personal data, or other secrets are included.
- [ ] A release-note label is selected (`feat`, `fix`, `docs`, `chore`, `ci`, or `refactor`).
