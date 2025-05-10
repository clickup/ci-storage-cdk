import { InstanceToAmi } from "@clickup/instance-to-ami-cdk";
import { ArnFormat, Duration, Stack, Tags } from "aws-cdk-lib";
import { HttpApi, HttpMethod, VpcLink } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpNlbIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AutoScalingGroup,
  BlockDeviceVolume,
  EbsDeviceVolumeType,
  GroupMetrics,
  OnDemandAllocationStrategy,
  Schedule,
  SpotAllocationStrategy,
  UpdatePolicy,
} from "aws-cdk-lib/aws-autoscaling";
import type {
  CfnAutoScalingGroup,
  CronOptions,
} from "aws-cdk-lib/aws-autoscaling";
import type { IKeyPair, IVpc } from "aws-cdk-lib/aws-ec2";
import {
  CfnInstance,
  MachineImage,
  UserData,
  LaunchTemplate,
  KeyPair as Ec2KeyPair,
  SecurityGroup,
  Port,
} from "aws-cdk-lib/aws-ec2";
import {
  NetworkLoadBalancer,
  NetworkTargetGroup,
  Protocol,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { InstanceIdTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import type { RoleProps } from "aws-cdk-lib/aws-iam";
import {
  ManagedPolicy,
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
import {
  SSM_IMAGE_NAME_ARM64,
  cloudConfigBuild,
} from "./internal/cloudConfigBuild";
import { cloudConfigYamlDump } from "./internal/cloudConfigYamlDump";
import { dedent } from "./internal/dedent";
import { namer } from "./internal/namer";
import { userDataCausesReplacement } from "./internal/userDataCausesReplacement";

/**
 * Only plain primitive typed properties are allowed to simplify usage of this
 * tool in other CDKs. No real Constructs or imported CDK interfaces. (The
 * exception is `vpc` for now, since when importing it by vpcId, it puts too
 * much ugly data in cdk.context.json.)
 */
export interface CiStorageProps {
  /** VPC to use by this construct. */
  vpc: IVpc;
  /** Instance Profile Role inline policies for all created instances. */
  inlinePolicies: RoleProps["inlinePolicies"];
  /** All instance names (and hostname for the host instances) will be prefixed
   * with that value, separated by "-". */
  instanceNamePrefix: string;
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
  runners: Array<{
    /** Primary label of this runner group. */
    label: string;
    /** "{owner}/{repo}" which this self-hosted runners pool serves. */
    ghRepository: string;
    /** URL of docker-compose.yml (or compose.yml) directory. The tool will
     * sparse-checkout that directory. The format is Dockerfile-compatible:
     * https://github.com/owner/repo[#[branch]:/directory/with/compose/] */
    ghDockerComposeDirectoryUrl: string;
    /** Size of the root volume. */
    volumeRootGb: number;
    /** If set, IOPS for the root volume. */
    volumeRootIops?: number;
    /** If set, throughput (MB/s) for the root volume. */
    volumeRootThroughput?: number;
    /** Size of /var/log volume. */
    volumeLogsGb: number;
    /** Size of swap file (if you need it). The swapfile will be placed on the
     * logs volume and increase its size (added to volumeLogsGb). */
    swapSizeGb?: number;
    /** The list of requirements to choose Spot Instances. */
    instanceRequirements: CfnAutoScalingGroup.InstanceRequirementsProperty[];
    /** The percentages of On-Demand Instances and Spot Instances for your
     * additional capacity. */
    onDemandPercentageAboveBaseCapacity: number;
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
  }>;
  /** Configuration for ci-storage host instance in the pool. This instance runs
   * ci-storage container, ci-scaler container and also common database services
   * reusable by self-hosted runners. Each self-hosted runner has its localhost
   * ports redirected to those instance's services. */
  host: {
    /** URL of docker-compose.yml (or compose.yml) directory. The tool will
     * sparse-checkout that directory. The format is Dockerfile-compatible:
     * https://github.com/owner/repo[#[branch]:/directory/with/compose/] */
    ghDockerComposeDirectoryUrl: string;
    /** List of profiles from docker compose file to start additionally. */
    dockerComposeProfiles?: string[];
    /** Size of the root volume. */
    volumeRootGb: number;
    /** If set, IOPS for the root volume. */
    volumeRootIops?: number;
    /** If set, throughput (MB/s) for the root volume. */
    volumeRootThroughput?: number;
    /** Size of swap file (if you need it). The swapfile will be placed to
     * /var/swapfile on the root volume. */
    swapSizeGb?: number;
    /** If set, mounts the entire /var/lib/docker host instance directory to
     * tmpfs with the provided max size (can be either a number or a string with
     * a suffix like "%"), and also copies it from the old instance when the
     * instance gets replaced. */
    varLibDockerOnTmpfsMaxSizeGb?: number | string;
    /** Full name of the Instance type. */
    instanceType: string;
    /** Ports to be open in the security group for connection from any CI
     * resources to the host (private IP addresses only). For a port marked as
     * isWebhook=true, the following AWS resources will also be created:
     * HttpApi->NLB->TargetGroup, where HttpApi will have an auto-generated AWS
     * domain with SSL enabled, and the whole chain will proxy all POST requests
     * (presumably, sent by GitHub webhooks) to the given host's port. */
    ports: Array<{ port: Port; description: string; isWebhook?: true }>;
  };
}

/**
 * A reusable Construct to launch ci-storage infra in some other stack. This
 * class is meant to be put in a public domain and then used in any project.
 *
 * - The construct launches a pool of self-hosted runners plus a  central "host"
 *   instance.
 * - On each instance, a corresponding GitHub repo is pulled (possibly using a
 *   sparse checkout), and then, `docker compose` is run. There is no need to
 *   pre-build any images or publish them anywhere, it's all done on the fly.
 *
 * Why vanilla EC2 instances + docker compose and not ECS or Fargate?
 *
 * 1. For ECS and Fargate, in 2 minutes after the termination warning, we only
 *    have more 2 minutes to shutdown the OS (it's documented, i.e. 4 minutes in
 *    total to cleanly shutdown). And for vanilla instances, people claim that
 *    the second timeout is way higher (although undocumented). We need more
 *    time to finish running CI jobs, and 4 minutes are not enough.
 * 2. We anyways need to run tests locally on Mac, and to do this, we use
 *    docker-compose. Which means that in the CI environment, we'd better use
 *    exactly the same configuration (same docker-compose), otherwise the
 *    environments diverge and are hard to debug/support.
 * 3. Tests often times need to run "Docker in Docker", which is problematic in
 *    ECS and Fargate environment.
 */
export class CiStorage extends Construct {
  public readonly vpc: IVpc;
  public readonly hostedZone?: IHostedZone;
  public readonly keyPair: IKeyPair;
  public readonly keyPairPrivateKeySecretName: string;
  public readonly roles: { runner: Role; host: Role };
  public readonly securityGroup: SecurityGroup;
  public readonly vpcLink: VpcLink;
  public readonly host: {
    fqdn: string | undefined;
    instance: CfnInstance;
  };
  public readonly autoScalingGroups: Array<{
    autoScalingGroup: AutoScalingGroup;
    launchTemplate: LaunchTemplate;
  }> = [];
  public readonly instanceToAmi: InstanceToAmi;
  public readonly logGroupName: string;
  constructor(
    public readonly scope: Construct,
    public readonly key: string,
    public readonly props: CiStorageProps,
  ) {
    super(scope, namer(key as any).pascal);
    const instanceNamePrefix = namer(props.instanceNamePrefix as any);

    const webhookHttpPort = parseInt(
      props.host.ports.find((p) => p.isWebhook)?.port.toString() || "0",
    );
    if (!webhookHttpPort) {
      throw Error(
        "One item in props.host.ports list must have isWebhook=true and be a single TCP port",
      );
    }

    const asgSpecs = props.runners.map((runner) => {
      const id = namer(
        "runner",
        runner.label.toLowerCase() as Lowercase<string>,
      );
      return { id, runner, asgName: id.pathKebabFrom(this) };
    });

    this.vpc = props.vpc;

    this.logGroupName = `/aws/ec2/${scope.node.id}-${this.node.id}Logs`;

    {
      const id = namer("zone");
      this.hostedZone = props.hostedZone
        ? HostedZone.fromHostedZoneAttributes(this, id.pascal, props.hostedZone)
        : undefined;
    }

    {
      const id = namer("ssh", "id", "rsa");
      const keyPair = new KeyPair(this, id.pascal, {
        name: id.pathKebabFrom(this),
        description:
          "Used to access ci-storage host from self-hosted runner nodes.",
      });
      this.keyPair = Ec2KeyPair.fromKeyPairName(
        this,
        namer(id, "key", "pair").pascal,
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
              [namer("key", "pair", "policy").pascal]: new PolicyDocument({
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
              [namer("gh", "token", "policy").pascal]: new PolicyDocument({
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
              [namer("tags", "policy").pascal]: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["ec2:DescribeTags"],
                    resources: ["*"],
                    // Describe* don't support resource-level permissions.
                  }),
                  new PolicyStatement({
                    actions: ["ec2:CreateTags"],
                    resources: [
                      Stack.of(this).formatArn({
                        service: "ec2",
                        resource: "instance",
                        resourceName: "*",
                        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                      }),
                    ],
                    conditions: {
                      StringEquals: {
                        "ec2:ResourceTag/aws:autoscaling:groupName":
                          asgSpecs.map(({ asgName }) => asgName),
                      },
                    },
                  }),
                ],
              }),
              ...(kind === "host"
                ? {
                    [namer("scaler", "policy").pascal]: new PolicyDocument({
                      statements: [
                        new PolicyStatement({
                          actions: ["ec2:DescribeInstances"],
                          resources: ["*"],
                          // Describe* don't support resource-level permissions.
                        }),
                        new PolicyStatement({
                          actions: ["autoscaling:DescribeAutoScalingGroups"],
                          resources: ["*"],
                          // Describe* don't support resource-level permissions.
                        }),
                        new PolicyStatement({
                          actions: [
                            "autoscaling:SetDesiredCapacity",
                            "autoscaling:TerminateInstanceInAutoScalingGroup",
                          ],
                          resources: [
                            Stack.of(this).formatArn({
                              service: "autoscaling",
                              resource: "autoScalingGroup",
                              resourceName: `*:autoScalingGroupName/${namer("*").pathKebabFrom(this)}`,
                              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                            }),
                          ],
                        }),
                      ],
                    }),
                  }
                : {}),
              [namer("cloud", "watch", "policy").pascal]: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: [
                      "logs:DescribeLogGroups",
                      "logs:DescribeLogStreams",
                    ],
                    resources: [
                      Stack.of(this).formatArn({
                        service: "logs",
                        resource: "log-group",
                        resourceName: "*",
                        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                      }),
                    ],
                  }),
                  new PolicyStatement({
                    actions: ["logs:CreateLogGroup"],
                    resources: [
                      Stack.of(this).formatArn({
                        service: "logs",
                        resource: "log-group",
                        resourceName: this.logGroupName,
                        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                      }),
                    ],
                  }),
                  new PolicyStatement({
                    actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    resources: [
                      Stack.of(this).formatArn({
                        service: "logs",
                        resource: "log-group",
                        resourceName: `${this.logGroupName}:log-stream:*`,
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
      this.securityGroup = new SecurityGroup(this, id.pascal, {
        securityGroupName: id.pathKebabFrom(this),
        description: id.pathKebabFrom(this),
        vpc: this.vpc,
      });
      Tags.of(this.securityGroup).add("Name", id.pathKebabFrom(this));
      for (const { port, description } of [
        { port: Port.tcp(22), description: "SSH" }, // to copy RAM drive from host to host
        ...props.host.ports,
      ]) {
        this.securityGroup.addIngressRule(
          this.securityGroup,
          port,
          `from ${namer(this.key as any).pathKebabFrom(scope)} to ${description}`,
        );
      }
    }

    {
      const id = namer("link");
      this.vpcLink = new VpcLink(this, id.pascal, {
        vpcLinkName: id.pathKebabFrom(this),
        vpc: this.vpc,
        securityGroups: [this.securityGroup],
      });
    }

    //
    // Host resources.
    //

    {
      const id = namer(
        instanceNamePrefix,
        "host",
        padStart("1", 3, "0").toString() as Lowercase<string>,
      );

      const recordName = id.kebab;
      const fqdn = this.hostedZone
        ? recordName + "." + this.hostedZone.zoneName.replace(/\.$/, "")
        : undefined;

      // HttpApi is needed to get an auto-generated AWS domain with SSL.
      const httpApi = new HttpApi(this, namer(id, "api").pascal, {
        apiName: id.pathKebabFrom(this),
      });

      const userData = UserData.custom(
        cloudConfigYamlDump(
          cloudConfigBuild({
            fqdn,
            ghTokenSecretName: props.ghTokenSecretName,
            ghDockerComposeDirectoryUrl: props.host.ghDockerComposeDirectoryUrl,
            dockerComposeEnv: {
              DOMAIN: httpApi.apiEndpoint,
              ASGS: asgSpecs
                .map(
                  ({ runner, asgName }) =>
                    `${runner.ghRepository}:${runner.label}:${asgName}`,
                )
                .join(" "),
            },
            dockerComposeProfiles: props.host.dockerComposeProfiles ?? [],
            dockerComposePrePullImages: [
              {
                repo: "ghcr.io",
                image: "dimikot/ci-storage",
                tags: ["main", "latest"],
              },
              {
                repo: "ghcr.io",
                image: "dimikot/ci-scaler",
                tags: ["main", "latest"],
              },
            ],
            dockerComposeCmdAfter: null,
            keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
            timeZone: props.timeZone,
            ephemeral: undefined,
            tmpfs: props.host.varLibDockerOnTmpfsMaxSizeGb
              ? {
                  path: "/var/lib/docker",
                  chmod: "710",
                  maxSizeGb: props.host.varLibDockerOnTmpfsMaxSizeGb,
                }
              : undefined,
            swapSizeGb: props.host.swapSizeGb,
            logGroupName: this.logGroupName,
          }),
        ),
      );

      const launchTemplate = new LaunchTemplate(this, namer(id, "lt").pascal, {
        launchTemplateName: id.pathKebabFrom(this),
        role: this.roles.host, // LaunchTemplate creates InstanceProfile internally
        requireImdsv2: true,
        httpPutResponseHopLimit: 2, // LaunchTemplate is the ONLY way to set it
        detailedMonitoring: true,
        // The properties below are set at LaunchTemplate level, since it's the
        // only way to set them when using AutoScalingGroup.
        machineImage: MachineImage.fromSsmParameter(SSM_IMAGE_NAME_ARM64),
        securityGroup: this.securityGroup,
        keyPair: this.keyPair,
        blockDevices: [
          {
            deviceName: "/dev/sda1",
            volume: BlockDeviceVolume.ebs(props.host.volumeRootGb, {
              encrypted: true,
              volumeType: EbsDeviceVolumeType.GP3,
              deleteOnTermination: true,
              iops: props.host.volumeRootIops,
              throughput: props.host.volumeRootThroughput,
            }),
          },
        ],
        userData,
      });

      const instance = new CfnInstance(this, namer(id, "instance").pascal, {
        launchTemplate: {
          launchTemplateId: launchTemplate.launchTemplateId,
          version: launchTemplate.versionNumber,
        },
        instanceType: props.host.instanceType,
        subnetId: this.vpc.privateSubnets[0].subnetId,
        availabilityZone: this.vpc.availabilityZones[0],
        tags: [{ key: "Name", value: fqdn ?? recordName }],
      });
      userDataCausesReplacement(instance, userData);

      if (this.hostedZone) {
        new ARecord(this, namer(id, "a").pascal, {
          zone: this.hostedZone,
          recordName,
          target: RecordTarget.fromIpAddresses(instance.attrPrivateIp),
          ttl: Duration.minutes(1),
        });
      }

      // NLB is needed, since it's the only reliable way for HttpApi to reach an
      // individual instance (HttpUrlIntegration doesn't work with private IPs
      // since there is no easy way to represent an HttpApi or VpcLink in a
      // security group's source/peer).
      const nlb = new NetworkLoadBalancer(this, namer(id, "nlb").pascal, {
        loadBalancerName: id.pathKebabFrom(this),
        vpc: this.vpc,
        internetFacing: false,
        securityGroups: [this.securityGroup],
      });
      const nlbTargetGroup = new NetworkTargetGroup(
        this,
        namer(id, "tg").pascal,
        {
          targetGroupName: id.pathKebabFrom(this),
          vpc: this.vpc,
          port: webhookHttpPort,
          targets: [new InstanceIdTarget(instance.ref)],
          healthCheck: {
            interval: Duration.seconds(5), // minimal possible
            timeout: Duration.seconds(2), // minimal possible
            healthyThresholdCount: 2, // minimal possible; appear healthy ASAP
            unhealthyThresholdCount: 10, // maximal possible; appear unhealthy after a long time
          },
        },
      );
      const nlbListener = nlb.addListener(namer("listener").pascal, {
        port: webhookHttpPort,
        protocol: Protocol.TCP,
        defaultTargetGroups: [nlbTargetGroup],
      });
      httpApi.addRoutes({
        path: "/{proxy+}",
        methods: [HttpMethod.POST],
        integration: new HttpNlbIntegration(
          namer("integration").pascal,
          nlbListener,
          { vpcLink: this.vpcLink },
        ),
      });

      this.host = { fqdn, instance };
    }

    //
    // Runner resources.
    //

    const instanceToAmiName = namer("instancetoami").pathKebabFrom(this);

    for (const { id, runner, asgName } of asgSpecs) {
      const userData = UserData.custom(
        cloudConfigYamlDump(
          cloudConfigBuild({
            fqdn: undefined, // no way to assign an unique hostname via LaunchTemplate
            ghTokenSecretName: props.ghTokenSecretName,
            ghDockerComposeDirectoryUrl: runner.ghDockerComposeDirectoryUrl,
            dockerComposeEnv: {
              // - GH_TOKEN: passed by cloudConfigBuild()
              // - TZ: passed by cloudConfigBuild()
              // - FORWARD_PORTS: implied to be set in ci-runner's compose.yml
              // - CI_STORAGE_HOST: implied to be set in ci-runner's compose.yml
              GH_REPOSITORY: runner.ghRepository,
              GH_LABELS: `${instanceNamePrefix.kebab},${runner.label}`,
              FORWARD_HOST: this.host.fqdn || this.host.instance.attrPrivateIp,
            },
            dockerComposeProfiles: [],
            dockerComposePrePullImages: [
              {
                repo: "ghcr.io",
                image: "dimikot/ci-runner",
                tags: ["main", "latest"],
              },
            ],
            dockerComposeCmdAfter: dedent(`
              export deps=$(docker image ls --format "{{.Repository}}:{{.ID}}:{{.Tag}}" | grep dimikot/ci-runner)
              export instanceId=$(cloud-init query ds.meta_data.instance_id)
              aws lambda invoke --function-name "${instanceToAmiName}" \\
                --cli-binary-format raw-in-base64-out \\
                --payload "$(jq -nc '{"instanceId":$ENV.instanceId,"deps":$ENV.deps}')" \\
                /dev/stdout | jq -s '.[0]'
            `),
            keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
            timeZone: props.timeZone,
            ephemeral: {
              path: "/var/log",
              chown: "0:syslog",
              chmod: "775",
            },
            tmpfs: undefined, // compose.yml will mount /mnt on tmpfs by itself
            swapSizeGb: runner.swapSizeGb,
            logGroupName: this.logGroupName,
          }),
        ),
      );

      const launchTemplate = new LaunchTemplate(this, namer(id, "lt").pascal, {
        launchTemplateName: id.pathKebabFrom(this),
        role: this.roles.runner, // LaunchTemplate creates InstanceProfile internally
        requireImdsv2: true,
        httpPutResponseHopLimit: 2, // LaunchTemplate is the ONLY way to set it
        detailedMonitoring: true,
        // The properties below are set at LaunchTemplate level, since it's the
        // only way to set them when using AutoScalingGroup.
        machineImage: MachineImage.fromSsmParameter(SSM_IMAGE_NAME_ARM64),
        securityGroup: this.securityGroup,
        keyPair: this.keyPair,
        blockDevices: [
          {
            deviceName: "/dev/sda1",
            volume: BlockDeviceVolume.ebs(runner.volumeRootGb, {
              encrypted: true,
              volumeType: EbsDeviceVolumeType.GP3,
              deleteOnTermination: true,
              iops: runner.volumeRootIops,
              throughput: runner.volumeRootThroughput,
            }),
          },
          {
            deviceName: "/dev/sdb", // doesn't matter, AWS renames them unpredictably
            volume: BlockDeviceVolume.ebs(
              runner.volumeLogsGb + (runner.swapSizeGb ?? 0),
              {
                encrypted: true,
                volumeType: EbsDeviceVolumeType.GP3,
                deleteOnTermination: true,
              },
            ),
          },
        ],
        userData,
      });

      const autoScalingGroup = new AutoScalingGroup(
        this,
        namer(id, "asg").pascal,
        {
          autoScalingGroupName: asgName,
          vpc: this.vpc,
          vpcSubnets: this.vpc.selectSubnets({
            // Create all instances in the same (first) AZ. This is needed to
            // save money on "fast snapshot restore" feature (see InstanceToAmi)
            // which charges ~$0.75 per snapshot per AZ per hour.
            availabilityZones: [this.vpc.availabilityZones.sort()[0]],
          }),
          minCapacity: Math.min(
            ...runner.minCapacity.map(({ value }) => value),
          ),
          maxCapacity: runner.maxCapacity,
          maxInstanceLifetime: runner.maxInstanceLifetime,
          capacityRebalance: true,
          mixedInstancesPolicy: {
            instancesDistribution: {
              onDemandAllocationStrategy:
                OnDemandAllocationStrategy.LOWEST_PRICE,
              onDemandPercentageAboveBaseCapacity:
                runner.onDemandPercentageAboveBaseCapacity,
              spotAllocationStrategy:
                SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
            },
            launchTemplate,
            launchTemplateOverrides: runner.instanceRequirements.map((req) => ({
              instanceRequirements: req,
            })),
          },
          cooldown: Duration.seconds(30),
          defaultInstanceWarmup: Duration.seconds(60),
          groupMetrics: [GroupMetrics.all()],
          updatePolicy: UpdatePolicy.rollingUpdate({
            maxBatchSize: runner.maxCapacity,
            minInstancesInService: 0,
            pauseTime: Duration.minutes(0),
          }),
        },
      );
      Tags.of(autoScalingGroup).add(
        "Name",
        namer(instanceNamePrefix, id).kebab,
      );

      for (const { id, value, cron } of runner.minCapacity) {
        autoScalingGroup.scaleOnSchedule(id, {
          minCapacity: value,
          timeZone: cron.timeZone ?? props.timeZone,
          schedule: Schedule.cron({ minute: "0", ...cron }),
        });
      }

      this.autoScalingGroups.push({ autoScalingGroup, launchTemplate });
    }

    //
    // InstanceToAmi
    //
    {
      const id = namer("instance", "to", "ami");
      this.instanceToAmi = new InstanceToAmi(this, id.pascal, {
        name: instanceToAmiName,
        autoScalingGroups: this.autoScalingGroups,
        addToRoles: Object.values(this.roles),
      });
    }
  }
}
