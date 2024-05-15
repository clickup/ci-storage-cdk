[@clickup/ci-storage-cdk](../README.md) / [Exports](../modules.md) / CiStorageProps

# Interface: CiStorageProps

Only plain primitive typed properties are allowed to simplify usage of this
tool in other CDKs. No real Constructs or imported CDK interfaces. (The
exception is `vpc` for now, since when importing it by vpcId, it puts too
much ugly data in cdk.context.json.)

## Properties

### vpc

• **vpc**: `IVpc`

VPC to use by this construct.

#### Defined in

[src/CiStorage.ts:57](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L57)

___

### inlinePolicies

• **inlinePolicies**: `undefined` \| \{ `[name: string]`: `PolicyDocument`;  }

Instance Profile Role inline policies to be used for all created
instances.

#### Defined in

[src/CiStorage.ts:60](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L60)

___

### instanceNamePrefix

• **instanceNamePrefix**: `string`

All instance names (and hostname for the host instances) will be prefixed
with that value, separated by "-".

#### Defined in

[src/CiStorage.ts:63](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L63)

___

### hostedZone

• `Optional` **hostedZone**: `Object`

A Hosted Zone to register the host instances in.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `hostedZoneId` | `string` | Id of the Zone. |
| `zoneName` | `string` | FQDN of the Zone. |

#### Defined in

[src/CiStorage.ts:65](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L65)

___

### ghTokenSecretName

• **ghTokenSecretName**: `string`

A name of secret in Secrets Manager which holds GitHub PAT. This secret
must pre-exist.

#### Defined in

[src/CiStorage.ts:73](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L73)

___

### timeZone

• `Optional` **timeZone**: `string`

Time zone for instances, example: America/Los_Angeles.

#### Defined in

[src/CiStorage.ts:75](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L75)

___

### runner

• **runner**: `Object`

Configuration for self-hosted runner instances in the pool.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `ghRepository` | `string` | "{owner}/{repository}" which this self-hosted runners pool serves. |
| `ghDockerComposeDirectoryUrl` | `string` | URL of docker-compose.yml (or compose.yml) directory. The tool will sparse-checkout that directory. The format is Dockerfile-compatible: https://github.com/owner/repo[#[branch]:/directory/with/compose/] |
| `imageSsmName` | `string` | SSM parameter name which holds the reference to an instance image. |
| `volumeGb` | `number` | Size of the root volume. |
| `swapSizeGb?` | `number` | Size of swap file (if you need it). |
| `tmpfsMaxSizeGb?` | `number` | If set, mounts /var/lib/docker to tmpfs with the provided max size. |
| `instanceRequirements` | [`InstanceRequirementsProperty`, ...InstanceRequirementsProperty[]] | The list of requirements to choose Spot Instances. |
| `scale` | \{ `onDemandPercentageAboveBaseCapacity`: `number` ; `maxActiveRunnersPercent`: \{ `periodSec`: `number` ; `value`: `number` ; `scalingSteps?`: `number`  } ; `minCapacity`: \{ `id`: `string` ; `value`: `number` ; `cron`: \{ `timeZone?`: `string`  } & `CronOptions`  }[] ; `maxCapacity`: `number` ; `maxInstanceLifetime`: `Duration`  } | Scaling options. |
| `scale.onDemandPercentageAboveBaseCapacity` | `number` | The percentages of On-Demand Instances and Spot Instances for your additional capacity. |
| `scale.maxActiveRunnersPercent` | \{ `periodSec`: `number` ; `value`: `number` ; `scalingSteps?`: `number`  } | Maximum percentage of active runners. If the MAX metric of number of active runners within the recent periodSec interval grows beyond this threshold, the autoscaling group will launch new instances until the percentage drops, or maxCapacity is reached. |
| `scale.maxActiveRunnersPercent.periodSec` | `number` | Calculate MAX metric within that period. The higher is the value, the slower will the capacity lower (but it doesn't affect how fast will it increase). |
| `scale.maxActiveRunnersPercent.value` | `number` | Value to use for the target percentage of active (busy) runners. |
| `scale.maxActiveRunnersPercent.scalingSteps?` | `number` | Desired number of ScalingInterval items in scalingSteps. |
| `scale.minCapacity` | \{ `id`: `string` ; `value`: `number` ; `cron`: \{ `timeZone?`: `string`  } & `CronOptions`  }[] | Minimal number of idle runners to keep, depending on the daytime. If the auto scaling group has less than this number of instances, the new instances will be created. |
| `scale.maxCapacity` | `number` | Maximum total number of instances. |
| `scale.maxInstanceLifetime` | `Duration` | Re-create instances time to time. |

#### Defined in

[src/CiStorage.ts:77](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L77)

___

### host

• **host**: `Object`

Configuration for ci-storage host instance in the pool. This instance also
runs common services reusable by self-hosted runners. Each self-hosted
runner has its localhost ports redirected to that instance.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `ghDockerComposeDirectoryUrl` | `string` | URL of docker-compose.yml (or compose.yml) directory. The tool will sparse-checkout that directory. The format is Dockerfile-compatible: https://github.com/owner/repo[#[branch]:/directory/with/compose/] |
| `dockerComposeProfiles?` | `string`[] | List of profiles from docker-compose to additionally start. |
| `imageSsmName` | `string` | SSM parameter name which holds the reference to an instance image. |
| `swapSizeGb?` | `number` | Size of swap file (if you need it). |
| `tmpfsMaxSizeGb?` | `number` | If set, mounts /var/lib/docker to tmpfs with the provided max size and copies it from the old instance when the instance gets replaced. |
| `instanceType` | `string` | Full name of the Instance type. |
| `machines` | `number` | Number of instances to create. |
| `ports` | \{ `port`: `Port` ; `description`: `string`  }[] | Ports to be open in the security group for connection from all runners to the host. |

#### Defined in

[src/CiStorage.ts:138](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L138)
