---
name: qa-testing
description: QA testing credentials and environment for Puppeteer-based UI testing against the deployed Vibecode Heaven application.
---

# QA Testing with Puppeteer

When using Puppeteer to test the deployed Vibecode Heaven application, use this account and environment.

## Environment

- **URL:** https://kirofactory-api.orangeriver-26cd2328.germanywestcentral.azurecontainerapps.io
- **Login page:** https://kirofactory-api.orangeriver-26cd2328.germanywestcentral.azurecontainerapps.io/login.html

## Credentials

| Field    | Value                            |
|----------|----------------------------------|
| Email    | kiro-qa@kirofactory.dev          |
| Password | KiroQA-28040d45acebc341          |

## Login Flow

1. Navigate to the login page
2. Fill `#loginEmail` with the email above
3. Fill `#loginPassword` with the password above
4. Click the login submit button
5. After redirect, you're on the main dashboard

## Notes

- This account has a real Kiro API key attached, so actual AI agent sessions can be started
  and will run for real. Full session flows (starting a session, sending prompts) can be
  exercised during QA testing, not just static page checks.
- Always use this account (never a personal account) for Puppeteer-based UI testing.
