# config/local (gitignored)

Only `*.example.json` files and this README are committed.

On your own machine you may create `denylist.txt` here: one term per line (employer name, product names of internal systems, people, deal or fund names). `scripts/check-employer-data.sh` blocks any commit or CI run that contains them. Never commit the deny-list itself, and never paste its contents into a Claude Code session.
