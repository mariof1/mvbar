Branch protection (GitHub UI)

To lock down `main` before making the repo public:

GitHub → Settings → Branches → Add rule
- Branch name pattern: `main`
- Require a pull request before merging
- Require status checks to pass before merging (select your CI workflow)
- Require conversation resolution (optional)
- Include administrators (recommended)
- Restrict who can push (optional)

This file can be deleted after you apply the settings.
