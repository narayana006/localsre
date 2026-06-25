---
name: aws
description: Deploy and troubleshoot AWS services — EC2, EKS, S3, RDS, Lambda, CloudWatch, IAM, VPC — via the AWS CLI or boto3.
---
# AWS

Auth: `aws configure` (access key + secret) or instance/pod IAM role (no config needed). Confirm identity: `aws sts get-caller-identity`. Set default region: `export AWS_DEFAULT_REGION=us-east-1` or pass `--region` on every call. Use `run_command` for all CLI ops.

## Discover any command
- `aws <service> help`, `aws <service> <cmd> help` — full flag reference
- `aws <service> list-*` / `describe-*` — enumerate resources
- Add `--output json | jq` or `--query` for filtering: `aws ec2 describe-instances --query 'Reservations[*].Instances[*].[InstanceId,State.Name,Tags[?Key==`Name`].Value]' --output table`

## EC2
- List instances: `aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,PrivateIpAddress,Tags[?Key==`Name`].Value]' --output table`
- SSH: `aws ssm start-session --target <instance-id>` (no bastion needed if SSM agent running)
- Start/stop: `aws ec2 start-instances/stop-instances --instance-ids <id>`
- Metrics: `aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 300 --statistics Average`

## EKS (Kubernetes)
- Update kubeconfig: `aws eks update-kubeconfig --name <cluster> --region <region>` → then use **kubernetes** skill
- List clusters: `aws eks list-clusters`
- Describe: `aws eks describe-cluster --name <cluster>`
- Node groups: `aws eks list-nodegroups --cluster-name <cluster>`; describe: `aws eks describe-nodegroup --cluster-name <cluster> --nodegroup-name <ng>`
- Troubleshoot: pod issues → kubernetes skill; node not joining → check IAM role, security groups, bootstrap script in node userdata

## S3
- List: `aws s3 ls s3://<bucket>/`; copy: `aws s3 cp <src> s3://<bucket>/<key>`; sync: `aws s3 sync . s3://<bucket>/`
- Bucket policy: `aws s3api get-bucket-policy --bucket <bucket>`
- ACL/public block: `aws s3api get-public-access-block --bucket <bucket>`

## RDS
- List: `aws rds describe-db-instances --query 'DBInstances[*].[DBInstanceIdentifier,DBInstanceStatus,Endpoint.Address]' --output table`
- Events: `aws rds describe-events --source-identifier <id> --source-type db-instance --duration 60`
- Logs: `aws rds download-db-log-file-portion --db-instance-identifier <id> --log-file-name error/mysql-error.log`
- Metrics: CloudWatch namespace `AWS/RDS` — FreeStorageSpace, DatabaseConnections, CPUUtilization, ReadLatency

## Lambda
- List: `aws lambda list-functions --query 'Functions[*].[FunctionName,Runtime,LastModified]' --output table`
- Invoke (sync): `aws lambda invoke --function-name <fn> --payload '{}' /tmp/out.json && cat /tmp/out.json`
- Logs: `aws logs tail /aws/lambda/<fn> --follow --since 1h`
- Deploy code: `aws lambda update-function-code --function-name <fn> --zip-file fileb://fn.zip`

## CloudWatch Logs
- List log groups: `aws logs describe-log-groups --query 'logGroups[*].logGroupName'`
- Tail: `aws logs tail <log-group> --follow --since 30m`
- Search: `aws logs filter-log-events --log-group-name <group> --filter-pattern "ERROR" --start-time $(date -d '1 hour ago' +%s000)`
- Metrics alarm: `aws cloudwatch describe-alarms --state-value ALARM`

## IAM
- Current identity: `aws sts get-caller-identity`
- List roles: `aws iam list-roles --query 'Roles[*].[RoleName,Arn]'`
- Effective permissions: `aws iam simulate-principal-policy --policy-source-arn <role-arn> --action-names s3:GetObject --resource-arns <resource-arn>`
- Attach policy: `aws iam attach-role-policy --role-name <role> --policy-arn arn:aws:iam::aws:policy/<PolicyName>`

## VPC / Networking
- List VPCs: `aws ec2 describe-vpcs`; subnets: `aws ec2 describe-subnets`
- Security groups: `aws ec2 describe-security-groups --filters Name=group-name,Values=<name>`
- Network ACLs: `aws ec2 describe-network-acls`

Workflow for an incident: `aws cloudwatch describe-alarms --state-value ALARM` → identify affected resource → pull CloudWatch metrics + logs → check recent changes (CloudTrail: `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances`). Pair with **kubernetes** (EKS), **postgresql** (RDS), or **redis** (ElastiCache) skills.
