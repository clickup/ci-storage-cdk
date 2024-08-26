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

[src/CiStorage.ts:62](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L62)

___

### inlinePolicies

• **inlinePolicies**: `undefined` \| \{ `[name: string]`: `PolicyDocument`;  }

Instance Profile Role inline policies for all created instances.

#### Defined in

[src/CiStorage.ts:64](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L64)

___

### instanceNamePrefix

• **instanceNamePrefix**: `string`

All instance names (and hostname for the host instances) will be prefixed
with that value, separated by "-".

#### Defined in

[src/CiStorage.ts:67](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L67)

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

[src/CiStorage.ts:69](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L69)

___

### ghTokenSecretName

• **ghTokenSecretName**: `string`

A name of secret in Secrets Manager which holds GitHub PAT. This secret
must pre-exist.

#### Defined in

[src/CiStorage.ts:77](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L77)

___

### timeZone

• `Optional` **timeZone**: `string`

Time zone for instances, example: America/Los_Angeles.

#### Defined in

[src/CiStorage.ts:79](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L79)

___

### runners

• **runners**: \{ `label`: `string` ; `ghRepository`: `string` ; `ghDockerComposeDirectoryUrl`: `string` ; `imageSsmName`: `string` ; `volumeRootGb`: `number` ; `volumeRootIops?`: `number` ; `volumeRootThroughput?`: `number` ; `volumeLogsGb`: `number` ; `swapSizeGb?`: `number` ; `instanceRequirements`: [`InstanceRequirementsProperty`, ...InstanceRequirementsProperty[]] ; `onDemandPercentageAboveBaseCapacity`: `number` ; `minCapacity`: \{ `id`: `string` ; `value`: `number` ; `cron`: \{ `timeZone?`: `string`  } & `CronOptions`  }[] ; `maxCapacity`: `number` ; `maxInstanceLifetime`: `Duration`  }[]

Configuration for self-hosted runner instances in the pool.

#### Defined in

[src/CiStorage.ts:81](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L81)

___

### host

• **host**: `Object`

Configuration for ci-storage host instance in the pool. This instance runs
ci-storage container, ci-scaler container and also common database services
reusable by self-hosted runners. Each self-hosted runner has its localhost
ports redirected to those instance's services.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `ghDockerComposeDirectoryUrl` | `string` | URL of docker-compose.yml (or compose.yml) directory. The tool will sparse-checkout that directory. The format is Dockerfile-compatible: https://github.com/owner/repo[#[branch]:/directory/with/compose/] |
| `dockerComposeProfiles?` | `string`[] | List of profiles from docker-compose to additionally start. |
| `imageSsmName` | `string` | SSM parameter name which holds the reference to an instance image. |
| `swapSizeGb?` | `number` | Size of swap file (if you need it). The swapfile will be placed to /var/swapfile on the root volume. |
| `varLibDockerOnTmpfsMaxSizeGb?` | `number` | If set, mounts the entire /var/lib/docker host instance directory to tmpfs with the provided max size, and also copies it from the old instance when the instance gets replaced. |
| `instanceType` | `string` | Full name of the Instance type. |
| `ports` | \{ `port`: `Port` ; `description`: `string` ; `isWebhook?`: ``true``  }[] | Ports to be open in the security group for connection from any CI resources to the host (private IP addresses only). For a port marked as isWebhook=true, the following AWS resources will also be created: HttpApi->NLB->TargetGroup, where HttpApi will have an auto-generated AWS domain with SSL enabled, and the whole chain will proxy all POST requests (presumably, sent by GitHub webhooks) to the given host's port. |

#### Defined in

[src/CiStorage.ts:133](https://github.com/clickup/ci-storage-cdk/blob/master/src/CiStorage.ts#L133)
