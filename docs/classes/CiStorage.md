[@clickup/ci-storage-cdk](../README.md) / [Exports](../modules.md) / CiStorage

# Class: CiStorage

A reusable Construct to launch ci-storage infra in some other stack. This
class is meant to be put in a public domain and then used in any project.

- The construct launches a pool of self-hosted runners plus a number of
  central "host" instances.
- On each instance, a corresponding GitHub repo is pulled (possibly using a
  sparse checkout), and then, `docker compose` is run. There is no need to
  pre-build any images or publish them anywhere, it's all on the fly.

Why vanilla EC2 instances + docker-compose and not ECS or Fargate?

1. Because for ECS and Fargate, in 2 minutes after the termination warning,
   we only have more 2 minutes to shutdown the OS (it's documented, i.e. 4
   minutes in total to cleanly shutdown). And for vanilla instances, people
   claim that the second timeout is way higher (although undocumented). We
   need more time to finish running CI jobs, and 4 minutes are not enough.
2. We anyways need to run tests locally on Mac, and to do this, we use
   docker-compose. Which means that in the CI environment, we'd better use
   exactly the same configuration (same docker-compose), otherwise the
   environments diverge and are hard to debug/support.

## Hierarchy

- `Construct`

  ↳ **`CiStorage`**

## Constructors

### constructor

• **new CiStorage**(`scope`, `key`, `props`): [`CiStorage`](CiStorage.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `scope` | `Construct` |
| `key` | `string` |
| `props` | [`CiStorageProps`](../interfaces/CiStorageProps.md) |

#### Returns

[`CiStorage`](CiStorage.md)

#### Overrides

Construct.constructor

#### Defined in

[src/CiStorage.ts:161](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L161)

## Properties

### vpc

• `Readonly` **vpc**: `IVpc`

#### Defined in

[src/CiStorage.ts:150](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L150)

___

### securityGroup

• `Readonly` **securityGroup**: `ISecurityGroup`

#### Defined in

[src/CiStorage.ts:151](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L151)

___

### keyPair

• `Readonly` **keyPair**: `IKeyPair`

#### Defined in

[src/CiStorage.ts:152](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L152)

___

### keyPairPrivateKeySecretName

• `Readonly` **keyPairPrivateKeySecretName**: `string`

#### Defined in

[src/CiStorage.ts:153](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L153)

___

### roles

• `Readonly` **roles**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `runner` | `Role` |
| `host` | `Role` |

#### Defined in

[src/CiStorage.ts:154](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L154)

___

### launchTemplate

• `Readonly` **launchTemplate**: `LaunchTemplate`

#### Defined in

[src/CiStorage.ts:155](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L155)

___

### autoScalingGroup

• `Readonly` **autoScalingGroup**: `AutoScalingGroup`

#### Defined in

[src/CiStorage.ts:156](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L156)

___

### hostedZone

• `Optional` `Readonly` **hostedZone**: `IHostedZone`

#### Defined in

[src/CiStorage.ts:157](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L157)

___

### hostInstances

• `Readonly` **hostInstances**: `Instance`[] = `[]`

#### Defined in

[src/CiStorage.ts:158](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L158)

___

### hostVolumes

• `Readonly` **hostVolumes**: `CfnVolume`[] = `[]`

#### Defined in

[src/CiStorage.ts:159](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L159)

___

### scope

• `Readonly` **scope**: `Construct`

#### Defined in

[src/CiStorage.ts:162](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L162)

___

### key

• `Readonly` **key**: `string`

#### Defined in

[src/CiStorage.ts:163](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L163)

___

### props

• `Readonly` **props**: [`CiStorageProps`](../interfaces/CiStorageProps.md)

#### Defined in

[src/CiStorage.ts:164](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L164)
