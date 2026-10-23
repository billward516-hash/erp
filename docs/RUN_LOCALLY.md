# Run it on your own computer (for usability testing)

The platform runs in this cloud session's container, which has no public web address, so to click through it yourself you run it on a computer you control. Hosting for testers (a shared address) needs a hosting decision first (owner item O-3).

## You need
- Node 22 or newer, Git, and PostgreSQL 16 (the `postgresql` server package; `scripts/dev-db.sh` starts a private copy on port 54329 and needs the PostgreSQL binaries installed, on Mac `brew install postgresql@16`, on Ubuntu/WSL `sudo apt install postgresql-16`).

## Steps
1. `git clone https://github.com/billward516-hash/erp && cd erp && git checkout claude/erp-architecture-foundation`
2. `npm ci`
3. `npm run db:start` (starts the private database)
4. `npm run seed` (creates the sample companies and prints a sign-in token for each sample person; also saved in `.storage/dev-tokens.json`)
5. Optional, for two years of history in the Stonebridge manufacturer: `npm run seed:history` (about 3 minutes)
6. `npm run web:build`
7. `npm start`, then open <http://localhost:3000>
8. On the sign-in page paste one token. Good starting points:
   - `dana (admin, all facilities)`: the manufacturer's administrator, sees everything
   - `priya (technician, DAY)` or `luis (technician, FTW)`: a technician's view
   - `kim (buyer)`, `riley (sales rep)`, `casey (billing)`, `morgan (finance approver)`
   - `kai (Lite: owner, Kessler)`: the Lite edition
   - `dee (service dispatcher, Summit)` and `tia (field technician, Summit)`: field service
9. The user guide opens from **Help** in the top bar (or <http://localhost:3000/guide/>).

To start over with fresh sample data: `npm run db:reset && npm run seed`.

## Notes
- Tokens are for testing only; real companies sign in through their identity provider (see the Administrator brief).
- Email is written to files, not sent, until a mail provider is connected.
- Use a tablet or phone on the same network by opening `http://<your computer's address>:3000`; installing as an app and offline use need HTTPS, which testing on localhost gets for free.
