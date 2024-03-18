import { ArnFormat, Duration, Stack, Tags } from "aws-cdk-lib";
import type { CfnAutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import {
  AutoScalingGroup,
  GroupMetrics,
  OnDemandAllocationStrategy,
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
} from "aws-cdk-lib/aws-ec2";
import type { RoleProps } from "aws-cdk-lib/aws-iam";
import {
  ManagedPolicy,
  PolicyDocument,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";
import { ARecord, RecordTarget, HostedZone } from "aws-cdk-lib/aws-route53";
import { KeyPair } from "cdk-ec2-key-pair";
import { Construct } from "constructs";
import yaml from "js-yaml";
import padStart from "lodash/padStart";
import range from "lodash/range";
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
      /** Maximum percentage of active runners. If the number of active runners
       * grows beyond this threshold, the autoscaling group will launch new
       * instances until the percentage drops. */
      maxActiveRunnersPercent: number;
      /** Minimal number of idle runners to keep. If the auto scaling group has
       * less than this number of idle runners, the new instances will be
       * created. */
      minIdleRunnersCount: number;
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
    /** Size of the root volume. */
    volumeGb: number;
    /** Full name of the Instance type. */
    instanceType: string;
    /** Number of instances to create. */
    machines: number;
  };
}

/**
 * Builds a reusable and never changing cloud config to be passed to the
 * instance's CloudInit service.
 */
function buildCloudConfig({
  fqdn,
  ghTokenSecretName,
  ghDockerComposeDirectoryUrl,
  keyPairPrivateKeySecretName,
}: {
  fqdn: string;
  ghTokenSecretName: string;
  ghDockerComposeDirectoryUrl: string;
  keyPairPrivateKeySecretName: string;
}) {
  if (!ghDockerComposeDirectoryUrl.match(/^([^#]+)(?:#([^:]*):(.*))?$/s)) {
    throw (
      "Cannot parse ghDockerComposeDirectoryUrl. It should be in format: " +
      "https://github.com/owner/repo[#[branch]:/directory/with/compose/]"
    );
  }

  const repoUrl = RegExp.$1;
  const branch = RegExp.$2 || "";
  const path = (RegExp.$3 || ".").replace(/^\/+|\/+$/gs, "");

  return {
    fqdn: fqdn || undefined,
    apt_sources: [
      {
        source: "deb https://cli.github.com/packages stable main",
        keyid: "23F3D4EA75716059",
        filename: "github-cli.list",
      },
      {
        source: "deb https://download.docker.com/linux/ubuntu $RELEASE stable",
        keyid: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
        filename: "docker.list",
      },
    ],
    packages: [
      "awscli",
      "gh",
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-compose-plugin",
      "git",
      "gosu",
      "mc",
      "curl",
      "apt-transport-https",
      "ca-certificates",
    ],
    write_files: [
      {
        path: "/etc/sysctl.d/enable-ipv4-forwarding.conf",
        content: dedent(`
          net.ipv4.conf.all.forwarding=1
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/increase-docker-shutdown-timeout.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          sed -i -E '/TimeoutStartSec=.*/a TimeoutStopSec=3600' /usr/lib/systemd/system/docker.service
          systemctl daemon-reload
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/switch-ssm-user-to-ubuntu-on-login.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          sed -i -E '/ExecStart=/i Environment="ENV=/etc/profile.ssm-user"' /etc/systemd/system/snap.amazon-ssm-agent.amazon-ssm-agent.service
          echo '[ "$0$@" = "sh" ] && ENV= sudo -u ubuntu -i' > /etc/profile.ssm-user
          systemctl daemon-reload
          systemctl restart snap.amazon-ssm-agent.amazon-ssm-agent.service || true
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-boot/run-docker-compose-on-boot.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          echo "*/1 * * * * ubuntu /home/ubuntu/run-docker-compose.sh 2>&1 | logger -t run-docker-compose" > /etc/cron.d/run-docker-compose
          exec /home/ubuntu/run-docker-compose.sh
        `),
      },
      {
        path: "/home/ubuntu/run-docker-compose.sh",
        owner: "ubuntu:ubuntu",
        permissions: "0755",
        defer: true,
        content: dedent(`
          #!/bin/bash
          set -e -o pipefail
          # Switch to non-privileged user if running as root.
          if [[ $(whoami) != "ubuntu" ]]; then
            exec gosu ubuntu:ubuntu "$BASH_SOURCE"
          fi
          # Ensure there is only one instance of this script running.
          exec {FD}<$BASH_SOURCE
          flock -n $FD || { echo "Already running."; exit 0; }
          # Load private and public keys from Secrets Manager to ~/.ssh.
          region=$(ec2metadata --availability-zone | sed "s/[a-z]$//")
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          aws secretsmanager get-secret-value --region "$region" \\
            --secret-id "${keyPairPrivateKeySecretName}" \\
            --query SecretString --output text \\
            > ~/.ssh/ci-storage
          chmod 600 ~/.ssh/ci-storage
          ssh-keygen -f ~/.ssh/ci-storage -y > ~/.ssh/ci-storage.pub
          # Load GitHub PAT from Secrets Manager and login to GitHub.
          aws secretsmanager get-secret-value --region "$region" \\
            --secret-id "${ghTokenSecretName}" \\
            --query SecretString --output text \\
            | gh auth login --with-token
          gh auth setup-git
          # Pull the repository and run docker compose.
          mkdir -p ~/git && cd ~/git
          if [[ ! -d .git ]]; then
            git clone -n --depth=1 --filter=tree:0 ${branch ? `-b "${branch}"` : ""} "${repoUrl}" .
            if [[ "${path}" != "." ]]; then
              git sparse-checkout set --no-cone "${path}"
            fi
            git checkout
          else
            git pull --rebase
          fi
          sudo usermod -aG docker ubuntu
          GH_TOKEN=$(gh auth token) exec sg docker -c 'cd "${path}" && docker compose pull && exec docker compose up --build -d'
        `),
      },
      {
        path: "/home/ubuntu/.bash_profile",
        owner: "ubuntu:ubuntu",
        permissions: "0644",
        defer: true,
        content: dedent(`
          #!/bin/bash
          if [ -d ~/git/"${path}" ]; then
            cd ~/git/"${path}"
            echo '$ docker compose ps'
            docker --log-level=ERROR compose ps --format "table {{.Service}}\\t{{.Status}}\\t{{.Ports}}"
            echo
          fi
        `),
      },
    ],
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
  public readonly role: Role;
  public readonly launchTemplate: LaunchTemplate;
  public readonly autoScalingGroup: AutoScalingGroup;
  public readonly hostedZone?: IHostedZone;
  public readonly hostInstances: Instance[] = [];

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
        "KeyPair",
        keyPair.keyPairName,
      );
      this.keyPairPrivateKeySecretName = `ec2-ssh-key/${this.keyPair.keyPairName}/private`;
    }

    {
      const id = namer("role");
      this.role = new Role(this, id.pascal, {
        roleName: namer("instance", "profile", "role").pathPascalFrom(this),
        assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AmazonEC2RoleforSSM",
          ),
          ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
        ],
        inlinePolicies: {
          ...props.inlinePolicies,
          CiStorageKeyPairPolicy: PolicyDocument.fromJson({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [
                  Stack.of(this).formatArn({
                    service: "secretsmanager",
                    resource: "secret",
                    resourceName: `${this.keyPairPrivateKeySecretName}*`,
                    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                  }),
                ],
              },
            ],
          }),
          CiStorageGhTokenPolicy: PolicyDocument.fromJson({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [
                  Stack.of(this).formatArn({
                    service: "secretsmanager",
                    resource: "secret",
                    resourceName: `${props.ghTokenSecretName}*`,
                    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                  }),
                ],
              },
            ],
          }),
        },
      });
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
        yarnDumpCloudConfig(
          buildCloudConfig({
            fqdn: "",
            ghTokenSecretName: props.ghTokenSecretName,
            ghDockerComposeDirectoryUrl:
              props.runner.ghDockerComposeDirectoryUrl,
            keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
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
        role: this.role, // LaunchTemplate creates InstanceProfile internally
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
        minCapacity: 1, // props.runner.scale.minIdleRunnersCount,
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
      const namespace = "ci-storage/metrics";
      this.autoScalingGroup.scaleToTrackMetric("ActiveRunnersPercent", {
        metric: new Metric({
          namespace,
          metricName: "ActiveRunnersPercent",
          dimensionsMap: { GH_REPOSITORY: props.runner.ghRepository },
          period: Duration.seconds(10),
          statistic: "max",
        }),
        targetValue: props.runner.scale.maxActiveRunnersPercent,
      });
      this.autoScalingGroup.scaleToTrackMetric("IdleRunnersCountInverse", {
        metric: new Metric({
          namespace,
          metricName: "IdleRunnersCountInverse",
          dimensionsMap: { GH_REPOSITORY: props.runner.ghRepository },
          period: Duration.seconds(10),
          statistic: "max",
        }),
        targetValue: 1000000 - props.runner.scale.minIdleRunnersCount,
      });
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
        const userData = UserData.custom(
          yarnDumpCloudConfig(
            buildCloudConfig({
              fqdn,
              ghTokenSecretName: props.ghTokenSecretName,
              ghDockerComposeDirectoryUrl:
                props.host.ghDockerComposeDirectoryUrl,
              keyPairPrivateKeySecretName: this.keyPairPrivateKeySecretName,
            }),
          ),
        );
        const instance = new Instance(
          this,
          namer(id, namer("instance")).pascal,
          {
            vpc: this.vpc,
            securityGroup: this.securityGroup,
            instanceType: new InstanceType(props.host.instanceType),
            machineImage,
            role: this.role,
            keyPair: this.keyPair,
            userData,
            blockDevices: [
              {
                deviceName: "/dev/sda1",
                volume: BlockDeviceVolume.ebs(props.host.volumeGb, {
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
    }
  }
}

/**
 * Removes leading indentation from all lines of the text.
 */
export function dedent(text: string): string {
  text = text.replace(/^([ \t\r]*\n)+/s, "").trimEnd();
  const matches = text.match(/^[ \t]+/s);
  return (
    (matches ? text.replace(new RegExp("^" + matches[0], "mg"), "") : text) +
    "\n"
  );
}

/**
 * Converts JS cloud-config representation to yaml user data script.
 */
function yarnDumpCloudConfig(obj: object): string {
  return (
    "#cloud-config\n" +
    yaml.dump(obj, {
      lineWidth: -1,
      quotingType: '"',
      styles: { "!!str": "literal" },
    })
  );
}
