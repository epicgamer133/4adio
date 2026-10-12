# CLAUDE.md

This project is **experimental**: the owner is still exploring its design and functionality.
Before changing anything, read [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md). It holds the
original vision, why the architecture is a true live broadcast, what's tested, and the open ideas.

- Keep the core guarantees: listeners only ever get `/stream` (no audio file URLs), and everyone stays in sync.
- Never commit `.env` or `data/` (admin password, private music).
- No build step: plain ES modules. Run locally with `start-local.bat` (http://127.0.0.1:8090, admin at `/admin`).
- Update docs/PROJECT_NOTES.md when a design decision changes.
