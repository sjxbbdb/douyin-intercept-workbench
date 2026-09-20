# Workflow lease contract

任务租约用于防止同一个授权工作流被两个桌面设备同时推进。租约身份来自当前登录会话的 `deviceId`，客户端不能自行声明其他设备。

## Endpoints

All endpoints require the normal user bearer token and an `idempotencyKey` of 8-200 characters.

```text
POST /v1/workflow-runs/:id/lease/acquire
POST /v1/workflow-runs/:id/lease/renew
POST /v1/workflow-runs/:id/lease/release
```

`acquire` and `renew` accept an optional `ttlMs` between 5,000 and 600,000 milliseconds. The default is 120,000 milliseconds. A device may reacquire its own active lease; another active device receives `LEASE_HELD`. An expired lease may be claimed by another device.

`renew` only succeeds for the current device while the lease is still active. `release` only succeeds for the current device, is safe after the run reached a terminal state, and clears the lease. Terminal runs (`COMPLETED`, `FAILED`, `STOPPED`) cannot be acquired or renewed.

Responses contain:

```json
{
  "action": "acquired|renewed|released",
  "runId": "run_…",
  "lease": {
    "owner": "user_…",
    "deviceId": "desktop-device-id",
    "expiresAt": 1790000000000
  }
}
```

The server persists `lease_owner`, `lease_device_id`, and `lease_expires_at` on `workflow_runs`. Startup migration adds these nullable columns to older SQLite databases. Lease operations are idempotent within their operation scope and produce audit entries with a hash of the device identifier.

## Desktop lifecycle

The desktop acquires a lease after creating a remote run and before marking it `RUNNING`. It renews immediately before checkpointing the result, requests the post-run decision, then releases the lease. Recovery acquires before health/recovery calls and renews before checkpointing. If acquisition or renewal fails, the client stops the flow and does not continue platform actions; an abnormal process exit leaves a bounded lease that can expire and be reclaimed.
