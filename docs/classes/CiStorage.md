[**@clickup/ci-storage-cdk**](../README.md)

***

[@clickup/ci-storage-cdk](../globals.md) / CiStorage

# Class: CiStorage

Defined in: [src/CiStorage.ts:188](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L188)

A reusable Construct to launch ci-storage infra in some other stack. This
class is meant to be put in a public domain and then used in any project.

- The construct launches a pool of self-hosted runners plus a  central "host"
  instance.
- On each instance, a corresponding GitHub repo is pulled (possibly using a
  sparse checkout), and then, `docker compose` is run. There is no need to
  pre-build any images or publish them anywhere, it's all done on the fly.

Why vanilla EC2 instances + docker compose and not ECS or Fargate?

1. For ECS and Fargate, in 2 minutes after the termination warning, we only
   have more 2 minutes to shutdown the OS (it's documented, i.e. 4 minutes in
   total to cleanly shutdown). And for vanilla instances, people claim that
   the second timeout is way higher (although undocumented). We need more
   time to finish running CI jobs, and 4 minutes are not enough.
2. We anyways need to run tests locally on Mac, and to do this, we use
   docker-compose. Which means that in the CI environment, we'd better use
   exactly the same configuration (same docker-compose), otherwise the
   environments diverge and are hard to debug/support.
3. Tests often times need to run "Docker in Docker", which is problematic in
   ECS and Fargate environment.

## Extends

- `Construct`

## Constructors

### new CiStorage()

> **new CiStorage**(`scope`, `key`, `props`): [`CiStorage`](CiStorage.md)

Defined in: [src/CiStorage.ts:206](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L206)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scope` | `Construct` |
| `key` | `string` |
| `props` | [`CiStorageProps`](../interfaces/CiStorageProps.md) |

#### Returns

[`CiStorage`](CiStorage.md)

#### Overrides

`Construct.constructor`

## Properties

| Property | Type | Default value |
| ------ | ------ | ------ |
| <a id="vpc"></a> `vpc` | `IVpc` | `undefined` |
| <a id="hostedzone"></a> `hostedZone?` | `IHostedZone` | `undefined` |
| <a id="keypair"></a> `keyPair` | `IKeyPair` | `undefined` |
| <a id="keypairprivatekeysecretname"></a> `keyPairPrivateKeySecretName` | `string` | `undefined` |
| <a id="roles"></a> `roles` | `object` | `undefined` |
| `roles.runner` | `Role` | `undefined` |
| `roles.host` | `Role` | `undefined` |
| <a id="securitygroup"></a> `securityGroup` | `SecurityGroup` | `undefined` |
| <a id="vpclink"></a> `vpcLink` | `VpcLink` | `undefined` |
| <a id="host"></a> `host` | `object` | `undefined` |
| `host.fqdn` | `undefined` \| `string` | `undefined` |
| `host.instance` | `CfnInstance` | `undefined` |
| <a id="autoscalinggroups"></a> `autoScalingGroups` | `object`[] | `[]` |
| <a id="instancetoami"></a> `instanceToAmi` | `InstanceToAmi` | `undefined` |
| <a id="loggroupname"></a> `logGroupName` | `string` | `undefined` |
| <a id="scope-1"></a> `scope` | `Construct` | `undefined` |
| <a id="key-1"></a> `key` | `string` | `undefined` |
| <a id="props-1"></a> `props` | [`CiStorageProps`](../interfaces/CiStorageProps.md) | `undefined` |
