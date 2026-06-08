---
name: servicenow
description: Create and manage ServiceNow incidents, change requests, problems, and CMDB records via the Table API.
---
# ServiceNow

Auth: Basic auth `-u "$SNOW_USER:$SNOW_PASS"` (or OAuth bearer). Base: `https://<instance>.service-now.com`.
Table API: `/api/now/table/<table>`. Always send `-H "Accept: application/json" -H "Content-Type: application/json"`. Use `run_command` with `curl` (+ `jq`).

## Incidents (table: `incident`)
- List open: `GET /api/now/table/incident?sysparm_query=active=true^state!=6&sysparm_limit=25&sysparm_display_value=true`
- Get one: `GET /api/now/table/incident?sysparm_query=number=INC0012345`
- Create: `POST /api/now/table/incident` body `{"short_description":"...","description":"...","urgency":"2","impact":"2","assignment_group":"<sys_id or name>"}`
- Update (by sys_id): `PUT /api/now/table/incident/<sys_id>` body `{"state":"2","work_notes":"investigating"}` (Table API treats a partial PUT body as a field-level update; some instances reject PATCH with 405).
  - Common states: 1=New, 2=In Progress, 6=Resolved, 7=Closed. Resolving needs `close_code` + `close_notes`.

## Change Requests (table: `change_request`)
- List: `GET /api/now/table/change_request?sysparm_query=active=true&sysparm_limit=25`
- Create (standard): `POST /api/now/table/change_request` body `{"short_description":"...","type":"standard","risk":"low","implementation_plan":"...","backout_plan":"..."}`
- Move through states / approvals: `PATCH /api/now/table/change_request/<sys_id>` (e.g. `{"state":"-2"}` assess, etc. — instance-specific).

## Problems (`problem`) & Requests (`sc_request`, `sc_req_item`)
- Same Table API pattern with the relevant table name.

## CMDB
- `GET /api/now/table/cmdb_ci?sysparm_query=name=<host>` to find a configuration item / service.

## Tips
- Use `sysparm_display_value=true` to get human-readable values (group/user names) instead of sys_ids.
- Use `sysparm_fields=number,short_description,state` to trim the payload.
- Encoded queries use `^` (AND), `^OR` (OR), operators like `=`, `!=`, `LIKE`, `>`, `<`.

SRE workflow: auto-create/enrich an incident from a PagerDuty/Datadog alert, draft the change request from a PR diff, and update work notes as you investigate. Pair with **pagerduty**, **datadog**, **atlassian**.
