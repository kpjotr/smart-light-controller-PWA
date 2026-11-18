# Security Profile — Pilot Baseline

**Framework:** Firebase Web & PWA Security Framework v1.1.0
**Project:** Smart Light Controller PWA
**Repository:** kpjotr/smart-light-controller-PWA
**Status:** Pilot baseline — not a compliance certification
**Created:** 2026-11-18
**Framework freshness:** package review date 2026-11-03; next framework audit due 2027-02-01.
**Handoff schema:** handoff_contracts.schema.json v1.1.0 verified available in the framework repository.

## 1. Scope and architecture
- Browser PWA (vanilla HTML/CSS/JavaScript).
- Firebase Authentication, Cloud Firestore, Realtime Database, Cloud Functions v2 and Firebase Hosting.
- Connected ESP32-S3 controller is an external device/system boundary maintained in a separate repository.
- Observed data paths: PWA ↔ Firebase Auth/Firestore/RTDB/Functions; ESP32 ↔ RTDB/Functions.
- Environment separation, App Check enforcement, IAM, backup, retention, legal basis, and production monitoring: **not verified in this pilot**.

## 2. Provisional risk decision
- **Provisional tier:** L2 pending owner confirmation.
- **Reason:** multi-user authenticated remote control, internet-exposed backend, device authorization and state-changing commands; Firebase Auth account data is personal data.
- **Onboarding:** provisionally Model A / device-mediated pairing; verify against the actual production process.
- Direct client writes are allowed only where Rules enforce authorized, bounded fields. Server/Admin SDK paths require separate authorization tests because they bypass Firestore Rules.

## 3. Active framework modules
| Module | Reason |
|---|---|
| 01 Core; 08 AI coding | all pilot work |
| 02 Firebase | Auth, Firestore, RTDB, Functions, Hosting |
| 03 Frontend/PWA | browser client and service worker |
| 04 Identity/access | user and device authorization |
| 05 API/integration | Functions and ESP/PWA boundaries |
| 06 DevSecOps | Git, dependencies, release workflow |
| 07 Privacy | user account data and telemetry |
| 09 Testing/threat model | authorization and state mutation testing |
| 10 Source register | freshness before implementation/release |
| 11 Reference templates | mandatory only for concrete Firebase implementation/tests |

## 4. Pilot threat focus
- Broken object/function authorization across Firestore and RTDB.
- Device/user identity spoofing or stale authorization after pairing changes.
- Unauthorized state commands, replay, tampering, and inconsistent PWA ↔ RTDB ↔ Function state.
- PWA cache or client logs exposing user/device data.
- Secrets or credentials in repository, agent output, logs, or browser bundle.
- Dependency, CI/CD, and release-pipeline compromise.

## 5. Pilot verification backlog
1. Confirm the tier and production/dev separation with the owner.
2. Create Rules positive/negative emulator tests for device ownership and unpairing.
3. Add independent authorization tests for each Admin SDK-triggered state transition.
4. Inventory personal data, purpose, retention, processors, and deletion/backup behavior.
5. Confirm App Check, API-key restrictions, IAM, budgets, backups, CSP/security headers, dependency scan and secret scan.
6. Validate every implementation handoff against the framework JSON Schema.

## 6. Release constraint
No pilot result authorizes deployment. FireFlow v1.3.0 remains unchanged and is run locally by the user only after explicit approval and a completed release gate.
