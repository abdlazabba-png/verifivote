# VerifiVote

**Offline-first election result verification, built for places where the network isn't.**

A progressive web app for capturing and verifying polling-unit results in North-East Nigeria's six states. Field agents record results on-device with no connection required; the data syncs when a signal returns, and a separate dashboard aggregates and verifies it.

## Why offline-first

Polling units in rural North-East Nigeria frequently have no usable mobile data. A result-capture tool that requires connectivity fails exactly where verification matters most. VerifiVote writes locally first and treats sync as an eventual, retryable background task rather than a precondition.

## Architecture

Two Vite bundles from one codebase:

| Bundle | Audience | Role |
|---|---|---|
| Field-agent PWA | Polling-unit agents | Offline capture, local persistence, background sync |
| Dashboard | Party and observer staff | Aggregation, verification, reporting |

**Party-data isolation** is enforced through a two-dimensional Cognito group model — a user's party and their role are separate dimensions, so an agent from one party cannot read another party's submissions even where records share a polling unit.

## Stack

- React + Vite
- AWS Amplify — hosting and CI
- AWS AppSync — GraphQL API
- Amplify DataStore — local persistence and conflict-resolved sync
- Amazon Cognito — auth and the group model above

## Status

Architecture and data model complete; field-agent capture and sync implemented. Not deployed to a live election.

## Running locally

```bash
npm install
npm run dev
```

Amplify environment configuration is not committed — see `.env.example`.

---

Built by [Abdulazeez Abba Tafida](https://www.linkedin.com/in/abdulazeez-abba-mnmgs-mnape-29109519b) · AA Tafeeda Worldwide Concepts
