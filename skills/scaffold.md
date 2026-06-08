---
name: scaffold
description: Create new projects from scratch in common stacks — React/Vite, Angular, Next.js, Vue, FastAPI, Flask, Streamlit, Node/Express.
---
# Scaffolding new projects

Goal: turn "build me an X in <tech>" into a running project. Use `run_command` + `write_file`, then VERIFY it runs.
Always use NON-INTERACTIVE flags so commands don't hang waiting for input.

## Frontend
- React (Vite): `npm create vite@latest <app> -- --template react` → `cd <app> && npm install` → run `npm run dev`
- React + TypeScript: same but `--template react-ts`
- Vue (Vite): `npm create vite@latest <app> -- --template vue`
- Angular: `npx -y @angular/cli new <app> --routing --style=css --skip-git --defaults` → run `ng serve`
- Next.js: `npx -y create-next-app@latest <app> --yes` → run `npm run dev`

## Python backend
- FastAPI: `python3 -m venv .venv && source .venv/bin/activate && pip install fastapi "uvicorn[standard]"` → write `main.py` with an `app` → run `uvicorn main:app --reload`
- Flask: `pip install flask` → write `app.py` → run `flask --app app run --debug`
- Streamlit: `pip install streamlit` → write `app.py` → run `streamlit run app.py`

## Node backend
- Express: `npm init -y && npm install express` → write `server.js` → run `node server.js`

## Workflow (do all of these)
1. Scaffold the project (CLI generator, or by hand with write_file for small apps).
2. Install dependencies (see python-env / the npm commands above).
3. Write the actual code the user asked for — real, working, not a stub.
4. VERIFY: start the dev server or run a smoke test, read the output, fix any errors, re-run until clean.
5. Report: how to run it and the local URL (e.g. http://localhost:5173 or :8000).

Reference the `python-env`, `homebrew`, or `github-ops` skills as needed.
