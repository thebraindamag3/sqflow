# Claude Code Instructions for thebraindamag3/sqflow

## GitHub CLI Rules (Apply Always in This Environment)

This cloud environment uses a proxy that causes issues with standard gh CLI defaults. Always follow these rules for every `gh issue` / `gh pr` command:

### Always Add `--repo`
```
--repo thebraindamag3/sqflow
```
Never rely on git remotes — the proxy causes errors.

### Safe Fields for `gh issue view` / `gh pr view`
Always use `--json` with **only** these safe fields (avoid `projectCards`/`projectItems` — deprecated and causes fatal errors):

```
number,title,state,body,labels,assignees,author,createdAt,updatedAt,closed,comments,url
```

**Recommended command:**
```bash
gh issue view NUMBER --repo thebraindamag3/sqflow \
  --json number,title,state,body,labels,assignees,author,createdAt,updatedAt,closed,comments,url \
  2>/dev/null
```

### Field Names
- Use `assignees` (plural), NOT `assignee`
- Use `labels` (plural), NOT `label`
- Use `comments` (plural), NOT `comment`

### Common Commands

**Create PR:**
```bash
gh pr create --title "..." --body "..." --base main --head BRANCH --repo thebraindamag3/sqflow
```

**Comment on issue:**
```bash
gh issue comment NUMBER --body "..." --repo thebraindamag3/sqflow
```

**If a command fails** (exit 1, unknown field, deprecation error): retry with the safe `--json` fields above.

### Workflow
1. View issue safely with `--json` command
2. Create branch: `git checkout -b feature/issue-NUMBER-desc`
3. Make changes, test, commit
4. `git push origin HEAD`
5. Create PR: `gh pr create --repo thebraindamag3/sqflow ...`
6. Comment on issue with PR link: `gh issue comment NUMBER --body "Done in PR #X" --repo thebraindamag3/sqflow`

### Git Push
- Always use: `git push -u origin <branch-name>`
- Branch names must start with `claude/` and end with the session ID (otherwise push fails with HTTP 403)
- On network failure, retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s)

## Git / Pull Requests
- The default branch is `main`; never use `master` as the base branch for pull requests.
