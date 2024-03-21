import { ArnFormat, Duration, Stack, Tags } from "aws-cdk-lib";
import type {
  CfnAutoScalingGroup,
  CronOptions,
} from "aws-cdk-lib/aws-autoscaling";
import {
  AutoScalingGroup,
  GroupMetrics,
  OnDemandAllocationStrategy,
  Schedule,
  SpotAllocationStrategy,
  UpdatePolicy,
} from "aws-cdk-lib/aws-autoscaling";
import { Metric } from "aws-cdk-lib/aws-cloudwatch";
import type { IKeyPair, ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import {
  MachineImage,
  OperatingSystemType,
  UserData,
  LaunchTemplate,
  KeyPair as Ec2KeyPair,
  BlockDeviceVolume,
  EbsDeviceVolumeType,
  Instance,
  InstanceType,
  SecurityGroup,
  CfnVolume,
} from "aws-cdk-lib/aws-ec2";
import type { RoleProps } from "aws-cdk-lib/aws-iam";
import {
  ManagedPolicy,
  Policy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import { ARecord, RecordTarget, HostedZone } from "aws-cdk-lib/aws-route53";
import { KeyPair } from "cdk-ec2-key-pair";
import { Construct } from "constructs";
import padStart from "lodash/padStart";
import range from "lodash/range";
import { cloudConfigBuild } from "./internal/cloudConfigBuild";
import { cloudConfigYamlDump } from "./internal/cloudConfigYamlDump";
import { namer } from "./internal/namer";

/**
 * Only plain primitive typed properties are allowed to simplify usage of this
 * tool in other CDKs. No real Constructs or imported CDK interfaces. (The
 * exception is `vpc` for now, since when importing it by vpcId, it puts too
 * much ugly data in cdk.context.json.)
 */
export interface CiStorageProps {
  /** VPC to use by this construct. */
  vpc: IVpc;
  /** Instance Profile Role inline policies to be used for all created
   * instances. */
  inlinePolicies: RoleProps["inlinePolicies"];
  /** Id of the Security Group to set for the created instances. */
  securityGroupId: string;
  /** A Hosted Zone to register the host instances in. */
  hostedZone?: {
    /** Id of the Zone. */
    hostedZoneId: string;
    /** FQDN of the Zone. */
    zoneName: string;
  };
  /** A name of secret in Secrets Manager which holds GitHub PAT. This secret
   * must pre-exist. */
  ghTokenSecretName: string;
  /** Time zone for instances, example: America/Los_Angeles. */
  timeZone?: string;
  /** Configuration for self-hosted runner instances in the pool. */
  runner: {
    /** "{owner}/{repository}" which this self-hosted runners pool serves. */
    ghRepository: string;
    /** URL of docker-compose.yml (or compose.yml) directory. The tool will
     * sparse-checkout that directory. The format is Dockerfile-compatible:
     * https://github.com/owner/repo[#[branch]:/directory/with/compose/] */
    ghDockerComposeDirectoryUrl: string;
    /** SSM parameter name which holds the reference to an instance image. */
    imageSsmName: string;
    /** Size of the root volume. */
    volumeGb: number;
    /** The list of requirements to choose Spot Instances. */
    instanceRequirements: [
      CfnAutoScalingGroup.InstanceRequirementsProperty,
      ...CfnAutoScalingGroup.InstanceRequirementsProperty[],
    ];
    /** Scaling options. */
    scale: {
      /** The percentages of On-Demand Instances and Spot Instances for your
       * additional capacity. */
      onDemandPercentageAboveBaseCapacity: number;
      /** Maximum percentage of active runners. If the MAX metric of number of
       * active runners within the recent periodSec interval grows beyond this
       * threshold, the autoscaling group will launch new instances until the
       * percentage drops, or maxCapacity is reached. */
      maxActiveRunnersPercent: {
        /** Calculate MAX metric within that period. The higher is the value,
         * the slower will the capacity lower (but it doesn't affect how fast
         * will it increase). */
        periodSec: number;
        /** Value to use for the target percentage of active (busy) runners. */
        value: number;
      };
      /** Minimal number of idle runners to keep, depending on the daytime. If
       * the auto scaling group has less than this number of instances, the new
       * instances will be created. */
      minCapacity: Array<{
        /** Alpha-numeric id of this schedule. */
        id: string;
        /** Value to assign to minCapacity when reaching the schedule time. Note
         * that it doesn't apply retrospectively, i.e. there is no processing of
         * past-due schedules in AWS. */
        value: number;
        /** Schedule info. Time zone example: America/Los_Angeles. */
        cron: { timeZone?: string } & CronOptions;
      }>;
      /** Maximum total number of instances. */
      maxCapacity: number;
      /** Re-create instances time to time. */
      maxInstanceLifetime: Duration;
    };
  };
  /** Configuration for ci-storage host instance in the pool. This instance also
   * runs common services reusable by self-hosted runners. Each self-hosted
   * runner has its localhost ports redirected to that instance. */
  host: {
    /** URL of docker-compose.yml (or compose.yml) directory. The tool will
     * sparse-checkout that directory. The format is Dockerfile-compatible:
     * https://github.com/owner/repo[#[branch]:/directory/with/compose/] */
    ghDockerComposeDirectoryUrl: string;
    /** SSM parameter name which holds the reference to an instance image. */
    imageSsmName: string;
    /** IOPS of the docker volume. */
    volumeIops: number;
    /** Throughput of the docker volume in MiB/s. */
    volumeThroughput: number;
    /** Size of the docker volume. */
    volumeGb: number;
    /** Full name of the Instance type. */
    instanceType: string;
    /** Number of instances to create. */
    machines: number;
  };
}

/**
 * A reusable Construct to launch ci-storage infra in some other stack. This
 * class is meant to be put in a public domain and then used in any project.
 *
 * - The construct launches a pool of self-hosted runners plus a number of
 *   central "host" instances.
 * - On each instance, a corresponding GitHub repo is pulled (possibly using a
 *   sparse checkout), and then, `docker compose` is run. There is no need to
 *   pre-build any images or publish them anywhere, it's all on the fly.
 *
 * Why vanilla EC2 instances + docker-compose and not ECS or Fargate?
 *
 * 1. Because for ECS and Fargate, in 2 minutes after the termination warning,
 *    we only have more 2 minutes to shutdown the OS (it's documented, i.e. 4
 *    minutes in total to cleanly shutdown). And for vanilla instances, people
 *    claim that the second timeout is way higher (although undocumented). We
 *    need more time to finish running CI jobs, and 4 minutes are not enough.
 * 2. We anyways need to run tests locally on Mac, and to do this, we use
 *    docker-compose. Which means that in the CI environment, we'd better use
 *    exactly the same configuration (same docker-compose), otherwise the
 *    environments diverge and are hard to debug/support.
 */
export class CiStorage extends Construct {
  public readonly vpc: IVpc;
  public readonly securityGroup: ISecurityGroup;
  public readonly keyPair: IKeyPair;
  public readonly keyPairPrivateKeySecretName: string;
  public readonly roles: { runner: Role; host: Role };
  public readonly launchTemplate: LaunchTemplate;
  public readonly autoScalingGroup: AutoScalingGroup;
  public readonly hostedZone?: IHostedZone;
  public readonly hostInstances: Instance[] = [];
  public readonly hostVolumes: CfnVolume[] = [];

  constructor(
    public readonly scope: Construct,
    public readonly key: string,
    public readonly props: CiStorageProps,
  ) {
    super(scope, key);

    const keyNamer = namer(key as any);

    this.vpc = props.vpc;

    {
      const id = namer("ssh", "id", "rsa");
      const keyPair = new KeyPair(this, id.pascal, {
        name: id.pathKebabFrom(this),
        description:
          "Used to access ci-storage host from self-hosted runner nodes.",
      });
      this.keyPair = Ec2KeyPair.fromKeyPairName(
        this,
        namer("key", "pair").pascal,
        keyPair.keyPairName,
      );
      this.keyPairPrivateKeySecretName = `ec2-ssh-key/${this.keyPair.keyPairName}/private`;
    }

    {
      this.roles = Object.fromEntries(
        (["runner", "host"] as const).map((kind) => [
          kind,
          new Role(this, namer(kind, "role").pascal, {
            roleName: namer(kind, "role").pathPascalFrom(this),
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
              ManagedPolicy.fromAwsManagedPolicyName(
                "service-role/AmazonEC2RoleforSSM",
              ),
              ManagedPolicy.fromAwsManagedPolicyName(
                "CloudWatchAgentServerPolicy",
              ),
            ],
            inlinePolicies: {
              ...props.inlinePolicies,
              [namer(keyNamer, "key", "pair", "policy").pascal]:
                new PolicyDocument({
                  statements: [
                    new PolicyStatement({
                      actions: ["secretsmanager:GetSecretValue"],
                      resources: [
                        Stack.of(this).formatArn({
                          service: "secretsmanager",
                          resource: "secret",
                          resourceName: `${this.keyPairPrivateKeySecretName}*`,
                          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                        }),
                      ],
                    }),
                  ],
                }),
              [namer(keyNamer, "gh", "token", "policy").pascal]:
                new PolicyDocument({
                  statements: [
                    new PolicyStatement({
                      actions: ["secretsmanager:GetSecretValue"],
                      resources: [
                        Stack.of(this).formatArn({
                          service: "secretsmanager",
                          resource: "secret",
                          resourceName: `${props.ghTokenSecretName}*`,
                          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                        }),
                      ],
                    }),
                  ],
                }),
            },
          }),
        ]),
      ) as typeof this.roles;
    }

    {
      const id = namer("sg");
      this.securityGroup = SecurityGroup.fromSecurityGroupId(
        this,
        id.pascal,
        props.securityGroupId,
      );
    }

    {
      const userData = UserData.custom(
        cloudConfigYamlDump(
          cloudConfigBuild({
            fqdn: "",
            ghTokenSecretName: props.ghTokenSecretName,
            ghDockerComposeDirectoryUrl:
              props.runner.ghDockerComposeDirectoryUrl,
            keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
            timeZone: props.timeZone,
            mount: undefined,
          }),
        ),
      );
      const id = namer("launch", "template");
      this.launchTemplate = new LaunchTemplate(this, id.pascal, {
        launchTemplateName: keyNamer.pathKebabFrom(scope),
        machineImage: MachineImage.fromSsmParameter(props.runner.imageSsmName, {
          os: OperatingSystemType.LINUX,
        }),
        keyPair: this.keyPair,
        role: this.roles.runner, // LaunchTemplate creates InstanceProfile internally
        blockDevices: [
          {
            deviceName: "/dev/sda1",
            volume: BlockDeviceVolume.ebs(props.runner.volumeGb, {
              encrypted: true,
              volumeType: EbsDeviceVolumeType.GP2,
              deleteOnTermination: true,
            }),
          },
        ],
        userData,
        securityGroup: this.securityGroup,
        requireImdsv2: true,
        httpPutResponseHopLimit: 2,
      });
      this.launchTemplate.node.addDependency(this.keyPair);
    }

    {
      const id = namer("auto", "scaling", "group");
      this.autoScalingGroup = new AutoScalingGroup(this, id.pascal, {
        autoScalingGroupName: keyNamer.pathKebabFrom(scope),
        vpc: this.vpc,
        maxCapacity: props.runner.scale.maxCapacity,
        maxInstanceLifetime: props.runner.scale.maxInstanceLifetime,
        mixedInstancesPolicy: {
          instancesDistribution: {
            onDemandAllocationStrategy: OnDemandAllocationStrategy.LOWEST_PRICE,
            onDemandPercentageAboveBaseCapacity:
              props.runner.scale.onDemandPercentageAboveBaseCapacity,
            spotAllocationStrategy:
              SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
          },
          launchTemplate: this.launchTemplate,
          launchTemplateOverrides: props.runner.instanceRequirements.map(
            (req) => ({
              instanceRequirements: req,
            }),
          ),
        },
        cooldown: Duration.seconds(30),
        defaultInstanceWarmup: Duration.seconds(60),
        groupMetrics: [GroupMetrics.all()],
        updatePolicy: UpdatePolicy.rollingUpdate(),
      });
      Tags.of(this.autoScalingGroup).add(
        "Name",
        namer(keyNamer, "runner").kebab,
      );
      this.autoScalingGroup.scaleToTrackMetric("ActiveRunnersPercent", {
        metric: new Metric({
          namespace: "ci-storage/metrics",
          metricName: "ActiveRunnersPercent",
          dimensionsMap: { GH_REPOSITORY: props.runner.ghRepository },
          period: Duration.seconds(
            props.runner.scale.maxActiveRunnersPercent.periodSec,
          ),
          statistic: "max",
        }),
        targetValue: props.runner.scale.maxActiveRunnersPercent.value,
      });
      for (const { id, value, cron } of props.runner.scale.minCapacity) {
        this.autoScalingGroup.scaleOnSchedule(id, {
          minCapacity: value,
          timeZone: cron.timeZone ?? props.timeZone,
          schedule: Schedule.cron(cron),
        });
      }
    }

    {
      const id = namer("zone");
      if (props.hostedZone) {
        this.hostedZone = HostedZone.fromHostedZoneAttributes(
          this,
          id.pascal,
          props.hostedZone,
        );
      }
    }

    {
      const machineImage = MachineImage.fromSsmParameter(
        props.host.imageSsmName,
        { os: OperatingSystemType.LINUX },
      );
      for (const i in range(props.host.machines)) {
        const id = namer(
          "host",
          namer(padStart(i + 1, 3, "0").toString() as any),
        );
        const recordName = namer(keyNamer, id).kebab;
        const fqdn = this.hostedZone
          ? recordName + "." + this.hostedZone.zoneName.replace(/\.$/, "")
          : "";

        // Unfortunately, there is no way in CDK to auto re-attach the volume to
        // an instance if that instance gets replaced. This is because
        // CloudFormation first launches a new instance while keeping the old
        // instance still running, so the volume can't be attached to the new
        // instance - it's already attached to the old one. The solution we use
        // here is to do the volume attachment via cloud-config at the new
        // instance's initial boot: it first stops the old instance from the new
        // one ("aws ec2 stop-instances"), then detaches the volume, and then
        // attaches it to the current instance. See logic in
        // cloudConfigBuild.ts.
        const volumeId = namer(id, "volume");
        const volume = new CfnVolume(this, volumeId.pascal, {
          availabilityZone: this.vpc.availabilityZones[0],
          autoEnableIo: true,
          encrypted: true,
          iops: props.host.volumeIops,
          throughput: props.host.volumeThroughput,
          size: props.host.volumeGb,
          volumeType: "gp3",
        });
        Tags.of(volume).add("Name", volumeId.pathKebabFrom(this));
        this.hostVolumes.push(volume);

        const userData = UserData.custom(
          cloudConfigYamlDump(
            cloudConfigBuild({
              fqdn,
              ghTokenSecretName: props.ghTokenSecretName,
              ghDockerComposeDirectoryUrl:
                props.host.ghDockerComposeDirectoryUrl,
              keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
              timeZone: props.timeZone,
              mount: { volumeId: volume.attrVolumeId, path: "/mnt" },
            }),
          ),
        );

        const instance = new Instance(
          this,
          namer(id, namer("instance")).pascal,
          {
            vpc: this.vpc,
            securityGroup: this.securityGroup,
            availabilityZone: this.vpc.availabilityZones[0],
            instanceType: new InstanceType(props.host.instanceType),
            machineImage,
            role: this.roles.host,
            keyPair: this.keyPair,
            userData,
            blockDevices: [
              {
                deviceName: "/dev/sda1",
                volume: BlockDeviceVolume.ebs(20, {
                  encrypted: true,
                  volumeType: EbsDeviceVolumeType.GP2,
                  deleteOnTermination: true,
                }),
              },
            ],
            userDataCausesReplacement: true,
            requireImdsv2: true,
          },
        );
        Tags.of(instance.instance).add("Name", fqdn);
        this.hostInstances.push(instance);

        if (this.hostedZone) {
          new ARecord(this, namer(id, namer("a")).pascal, {
            zone: this.hostedZone,
            recordName,
            target: RecordTarget.fromIpAddresses(instance.instancePrivateIp),
            ttl: Duration.minutes(1),
          });
        }
      }

      {
        const id = namer("host", "volume", "policy");
        const conditions = {
          StringEquals: {
            ["ec2:ResourceTag/aws:cloudformation:stack-name"]:
              Stack.of(this).stackName,
          },
        };
        this.roles.host.attachInlinePolicy(
          new Policy(this, id.pascal, {
            policyName: namer(keyNamer, id).pascal,
            statements: [
              new PolicyStatement({
                actions: ["ec2:DescribeVolumes", "ec2:DescribeInstances"],
                resources: ["*"],
                // Describe* don't support resource-level permissions and
                // conditions.
              }),
              new PolicyStatement({
                actions: [
                  "ec2:StopInstances",
                  "ec2:DetachVolume",
                  "ec2:AttachVolume",
                ],
                conditions, // filter by conditions, not by resource ARNs
                resources: [
                  Stack.of(this).formatArn({
                    service: "ec2",
                    resource: "instance",
                    resourceName: "*",
                    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                  }),
                  Stack.of(this).formatArn({
                    service: "ec2",
                    resource: "volume",
                    resourceName: "*",
                    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                  }),
                ],
              }),
            ],
          }),
        );
      }
    }
  }
}
