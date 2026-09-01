# Mobile device decision

Decision date: 2026-08-31
Status: **Deferred; no pilot**

OpenInstinct will not provision or operate an Android or iOS device layer. No
mobile-only, high-value recurring owner workflow has been demonstrated, so the
conditional Phase 7 entry gate fails before device custody testing. No test or
owner account was enrolled, no paid resource was created, and no production
infrastructure changed.

Public shared device fleets are categorically excluded from identity custody.
AWS states that physical Device Farm data is not encrypted at rest, logs and
video can be retained for 400 days, and data can persist between public sessions;
it recommends not entering Google, Apple, personal, or other sensitive account
information.

## Candidate Android approaches

| Requirement                       | Dedicated Android emulator                                                                                          | Dedicated physical Android device                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Appium/ADB control                | Feasible in documentation; not tested                                                                               | Feasible with developer/USB controls; not tested                                                                 |
| Persistence                       | AVD user-data disk and snapshots documented                                                                         | Native app/account state; custody process not designed                                                           |
| Encryption                        | Host, disk, key, and snapshot design required                                                                       | Hardware-backed device encryption possible; policy not demonstrated                                              |
| Reset and deletion                | `-wipe-data` clears AVD user data but not every separate image; complete host/storage deletion unverified           | Factory reset, account removal, eSIM/SIM handling, and physical disposition unverified                           |
| Owner takeover                    | Authenticated display/relay not designed                                                                            | Authenticated remote display/input not designed                                                                  |
| Notifications                     | Feasible; background delivery behavior untested                                                                     | Feasible; permission and lock-screen leakage untested                                                            |
| Play Integrity/emulator detection | Material compatibility risk; virtual integrity is app-specific and ordinary emulators may not meet device integrity | Stronger compatibility, but certification, bootloader, patch level, and automation detection remain app-specific |
| SIM/SMS                           | Requires separately controlled telephony; an emulator is not identity custody                                       | Requires dedicated carrier/eSIM custody, reset, regional, and consent controls                                   |
| Retention/decommissioning         | Host volumes, snapshots, logs, artifacts, and backups require verified deletion                                     | Device, MDM, backups, carrier identity, artifacts, and provider records require verified deletion                |
| Cost                              | Not measured                                                                                                        | Hardware, carrier, MDM, hosting, replacement, and operations not measured                                        |
| Decision                          | Does not pass                                                                                                       | Does not pass                                                                                                    |

The full live matrix remains intentionally unrun. It requires non-secret test
accounts and dedicated resources, and would still be unjustified without a real
mobile-only workflow. A future pilot must test persistence, encryption, reset,
provider-side deletion, short-lived owner takeover, notification redaction,
Play Integrity and emulator detection, SIM/SMS constraints, retention, measured
cost, provider failures, unknown-outcome reconciliation, and decommissioning.

## iOS is separate research

Android conclusions do not transfer to iOS. A future iOS program must separately
review Apple signing and distribution, XCUITest limitations, supervision/MDM,
Automated Device Enrollment availability, remote takeover, data protection,
backups, Activation Lock, eSIM removal, erase verification, retention, and Apple
platform policy. Apple documents that supervised organization-owned devices can
be enrolled through Apple Business Manager/School Manager and MDM, but this is
device administration—not evidence that arbitrary personal app workflows can be
safely automated. Some erase paths may preserve eSIM data, so decommissioning
must explicitly verify carrier identity removal.

## Reopening criteria

All of the following are required before creating a device resource:

1. At least two owner-requested, recurring workflows are genuinely mobile-only;
   connector, browser, and permitted desktop alternatives fail recorded tests.
2. A dedicated emulator or physical device is assigned to one deployment and
   uses test accounts until custody review passes.
3. Encryption, credential isolation, Appium/ADB bounds, authenticated takeover,
   notification redaction, and network policy are demonstrated.
4. Reset and decommissioning prove device, snapshot, backup, artifact, provider,
   account, and SIM/eSIM state absent while retaining non-secret evidence.
5. Consequential operations use durable idempotency; ambiguous completion is
   `unknown`, never automatically replayed, and reconciled read-only.
6. Measured monthly cost is owner-visible and below an explicit owner ceiling.
7. Security and platform-policy reviews explicitly approve the exact workflow.

Until then, capability routing stops before the mobile tier. A phone-call feature
must use a reviewed typed telephony connector, not a provisioned phone.

## Documentation checked

- Android Emulator command line, persistence, snapshots, and wipe behavior: <https://developer.android.com/studio/run/emulator-commandline>
- Play Integrity overview: <https://developer.android.com/google/play/integrity/overview>
- Play Integrity setup and verdicts: <https://developer.android.com/google/play/integrity/setup>
- AWS Device Farm data protection and retention: <https://docs.aws.amazon.com/devicefarm/latest/developerguide/data-protection.html>
- Apple Automated Device Enrollment and supervision: <https://support.apple.com/guide/security/automated-device-enrollment-secc2cd563ef/web>
- Apple cellular device management and eSIM reset behavior: <https://support.apple.com/guide/deployment/a-device-management-service-deploy-devices-dep12504a832/web>
