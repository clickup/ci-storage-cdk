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

[src/CiStorage.ts:48](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L48)

___

### inlinePolicies

• **inlinePolicies**: `undefined` \| \{ `[name: string]`: `PolicyDocument`;  }

Instance Profile Role inline policies to be used for all created
instances.

#### Defined in

[src/CiStorage.ts:51](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L51)

___

### securityGroupId

• **securityGroupId**: `string`

Id of the Security Group to set for the created instances.

#### Defined in

[src/CiStorage.ts:53](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L53)

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

[src/CiStorage.ts:55](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L55)

___

### ghTokenSecretName

• **ghTokenSecretName**: `string`

A name of secret in Secrets Manager which holds GitHub PAT. This secret
must pre-exist.

#### Defined in

[src/CiStorage.ts:63](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L63)

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
| `instanceRequirements` | [`InstanceRequirementsProperty`, ...InstanceRequirementsProperty[]] | The list of requirements to choose Spot Instances. |
| `scale` | \{ `onDemandPercentageAboveBaseCapacity`: `number` ; `maxActiveRunnersPercent`: `number` ; `minIdleRunnersCount`: `number` ; `maxCapacity`: `number` ; `maxInstanceLifetime`: `Duration`  } | Scaling options. |
| `scale.onDemandPercentageAboveBaseCapacity` | `number` | The percentages of On-Demand Instances and Spot Instances for your additional capacity. |
| `scale.maxActiveRunnersPercent` | `number` | Maximum percentage of active runners. If the number of active runners grows beyond this threshold, the autoscaling group will launch new instances until the percentage drops. |
| `scale.minIdleRunnersCount` | `number` | Minimal number of idle runners to keep. If the auto scaling group has less than this number of idle runners, the new instances will be created. |
| `scale.maxCapacity` | `number` | Maximum total number of instances. |
| `scale.maxInstanceLifetime` | `Duration` | Re-create instances time to time. |

#### Defined in

[src/CiStorage.ts:65](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L65)

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
| `imageSsmName` | `string` | SSM parameter name which holds the reference to an instance image. |
| `volumeGb` | `number` | Size of the root volume. |
| `instanceType` | `string` | Full name of the Instance type. |
| `machines` | `number` | Number of instances to create. |

#### Defined in

[src/CiStorage.ts:103](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L103)
