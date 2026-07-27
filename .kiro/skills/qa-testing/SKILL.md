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

| Field        | Value                                  |
|--------------|----------------------------------------|
| Email        | REDACTED_OLD_QA_EMAIL                |
| Password     | REDACTED_OLD_QA_PASSWORD                            |

## Login Flow

1. Navigate to the login page
2. Fill `#email` with the email above
3. Fill `#password` with the password above
4. Click the login submit button
5. After redirect, you're on the main dashboard

## Notes

- This is a QA/test account. The Kiro API Key is a placeholder and will not run actual AI agent sessions.
- Always use this account for Puppeteer-based UI testing on the deployed site.
