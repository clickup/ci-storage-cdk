import compact from "lodash/compact";
import { dedent } from "./dedent";

/**
 * Builds a reusable and never changing cloud config to be passed to the
 * instance's CloudInit service. This config is multi-purpose: it doesn't know
 * about the role of the instance (host or runner), it just initiates the
 * instance to run docker-compose file on it.
 */
export function cloudConfigBuild({
  fqdn,
  ghTokenSecretName,
  dockerComposeEnv,
  dockerComposeProfiles,
  ghDockerComposeDirectoryUrl,
  keyPairPrivateKeySecretName,
  timeZone,
  tmpfs,
  swapSizeGb,
}: {
  fqdn: string | undefined;
  ghTokenSecretName: string;
  ghDockerComposeDirectoryUrl: string;
  dockerComposeEnv: Record<string, string>;
  dockerComposeProfiles: string[];
  keyPairPrivateKeySecretName: string;
  timeZone: string | undefined;
  tmpfs: { path: string; maxSizeGb?: number } | undefined;
  swapSizeGb: number | undefined;
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
  const preamble = [
    "set -e -o pipefail",
    "echo ================",
    'echo "Running $BASH_SOURCE as $(whoami)"',
    "set -o xtrace",
    'export AWS_DEFAULT_REGION=$(ec2metadata --availability-zone | sed "s/[a-z]$//")',
  ].join(" && ");

  return {
    timezone: timeZone,
    fqdn: fqdn || undefined,
    hostname: fqdn || undefined,
    swap: swapSizeGb
      ? {
          filename: "/var/swapfile",
          size: "auto",
          maxsize: 1024 * 1024 * 1024 * swapSizeGb,
        }
      : undefined,
    mounts: tmpfs
      ? [
          [
            "tmpfs",
            tmpfs.path,
            "tmpfs",
            "defaults,noatime,exec,mode=0710,nr_inodes=0" +
              (tmpfs.maxSizeGb ? `,size=${tmpfs.maxSizeGb}G` : ""),
            "0",
            "0",
          ],
        ]
      : undefined,
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
      "qemu",
      "qemu-user-static",
      "binfmt-support",
      "git",
      "gosu",
      "mc",
      "curl",
      "apt-transport-https",
      "ca-certificates",
      "tzdata",
      "atop",
      "iotop",
      "htop",
      "bwm-ng",
      "jq",
    ],
    write_files: compact([
      {
        path: "/etc/sysctl.d/enable-ipv4-forwarding.conf",
        content: dedent(`
          net.ipv4.conf.all.forwarding=1
        `),
      },
      {
        path: "/etc/default/atop",
        content: dedent(`
          LOGOPTS="-R"
          LOGINTERVAL=15
          LOGGENERATIONS=4
        `),
      },
      timeZone && {
        path: "/etc/environment",
        append: true,
        content: dedent(`
          TZ="${timeZone}"
        `),
      },
      {
        path: "/etc/environment",
        append: true,
        content: dedent(`
          LESS="RS"
        `),
      },
      {
        path: "/etc/docker/daemon.json",
        permissions: "0644",
        content: dedent(`
          {
            "log-driver": "syslog",
            "log-opts": {
              "tag": "docker/{{.Name}}"
            },
            "runtimes": {
              "sysbox-runc": {
                "path": "/usr/bin/sysbox-runc"
              }
            },
            "default-runtime": "sysbox-runc",
            "userns-remap": "sysbox"
          }
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/apply-services-configs.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          service atop restart || true
          sysctl --system
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/increase-docker-shutdown-timeout.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          sed -i -E '/TimeoutStartSec=.*/a TimeoutStopSec=3600' /usr/lib/systemd/system/docker.service
          systemctl daemon-reload
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/add-ubuntu-user-to-docker-group-to-access-socket.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          usermod -aG docker ubuntu
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/install-sysbox-for-docker-in-docker.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          systemctl stop docker docker.socket || true
          wget -nv -O /tmp/sysbox-ce.deb "https://downloads.nestybox.com/sysbox/releases/v0.6.4/sysbox-ce_0.6.4-0.linux_$(dpkg --print-architecture).deb"
          dpkg -i /tmp/sysbox-ce.deb
          rm -f /tmp/sysbox-ce.deb
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/switch-ssm-user-to-ubuntu-on-login.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          echo '[ "$0$@" = "sh" ] && ENV= sudo -u ubuntu -i' > /etc/profile.ssm-user
          mkdir -p /etc/systemd/system/snap.amazon-ssm-agent.amazon-ssm-agent.service.d/
          (
            echo '[Service]'
            echo 'Environment="ENV=/etc/profile.ssm-user"'
          ) > /etc/systemd/system/snap.amazon-ssm-agent.amazon-ssm-agent.service.d/sh-env.conf
          systemctl daemon-reload
          systemctl restart snap.amazon-ssm-agent.amazon-ssm-agent.service || true
        `),
      },
      tmpfs &&
        fqdn && {
          path: "/var/lib/cloud/scripts/per-once/rsync-tmpfs-volume-from-old-instance.sh",
          permissions: "0755",
          content: dedent(`
            #!/bin/bash
            ${preamble}

            instance_id=$(ec2metadata --instance-id)
            stack_name=$(
              aws ec2 describe-tags \\
              --filters "Name=resource-id,Values=$instance_id" "Name=key,Values=aws:cloudformation:stack-name" \\
              --query "Tags[0].Value" --output text
            )
            logical_id=$(
              aws ec2 describe-tags \\
              --filters "Name=resource-id,Values=$instance_id" "Name=key,Values=aws:cloudformation:logical-id" \\
              --query "Tags[0].Value" --output text
            )
            old_instance_ip_addr=$(
              aws ec2 describe-instances \\
              --filters "Name=tag:Name,Values=${fqdn}" "Name=instance-state-name,Values=running" \\
              --query "Reservations[*].Instances[*].[InstanceId,PrivateIpAddress]" --output text \\
              | grep -v "$instance_id" | awk '{print $2}' | head -n1 || true
            )

            if [[ "$old_instance_ip_addr" != "" ]]; then
              # Load private key from Secrets Manager to ~/.ssh, to access the old host.
              mkdir -p ~/.ssh && chmod 700 ~/.ssh
              aws secretsmanager get-secret-value \\
                --secret-id "${keyPairPrivateKeySecretName}" \\
                --query SecretString --output text \\
                > ~/.ssh/id_rsa
              chmod 600 ~/.ssh/id_rsa

              # Stop Docker service on the current host.
              systemctl stop docker docker.socket || true

              # Stop Docker service on the old (source) host.
              ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                "ubuntu@$old_instance_ip_addr" "sudo systemctl stop docker docker.socket || true"

              # 1. Surprisingly, it takes almost the same amount of time to rsync-init
              #    (if we would run it without stopping Docker on the old host first)
              #    as to the follow-up rsync-over (after we stopped Docker on the source).
              #    This is probably because of the RAM drive and large Docker volumes. So
              #    we skip rsync-init and just go with one full rsync run (with downtime).
              # 2. Also, compression (even the fastest one) doesn't speed it up; probably
              #    because AWS network is faster than instances CPU still.
              time rsync \\
                -aHXS --one-file-system --numeric-ids --delete $@ \\
                --rsh="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \\
                --rsync-path="sudo rsync" \\
                "ubuntu@$old_instance_ip_addr:${tmpfs.path}/" "${tmpfs.path}/"

              # We do NOT start Docker service here! Otherwise, it may auto-start some
              # containers, those containers will expect the git directory to exist,
              # although it may not exist yet. So, we start Docker service in
              # run-docker-compose.sh (its 1st run), when we are sure that git is pulled.
            fi

            aws cloudformation signal-resource \\
              --stack-name "$stack_name" --logical-resource-id "$logical_id" \\
              --unique-id "$instance_id" --status SUCCESS
          `),
        },
      {
        path: "/etc/rsyslog.d/01-docker-tag-to-serial-console.conf",
        permissions: "0644",
        content: dedent(`
          if $syslogtag startswith 'docker/' then -/dev/console
          # It will also write to /var/log/syslog as usual.
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/allow-rsyslog-write-to-serial-console.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          usermod -a -G tty syslog
          systemctl restart rsyslog
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-boot/run-docker-compose-on-boot.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          echo "*/2 * * * * ubuntu /home/ubuntu/run-docker-compose.sh --no-logs 2>&1 | logger -t docker/run-docker-compose" > /etc/cron.d/run-docker-compose
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

          # Switch to non-privileged user if running as root.
          if [[ $(whoami) != "ubuntu" ]]; then
            exec gosu ubuntu "$BASH_SOURCE" "$@"
          fi

          # Ensure there is only one instance of this script running.
          exec {FD}<$BASH_SOURCE
          flock -n "$FD" || { echo "Already running."; exit 0; }
          ${preamble}

          # Make sure we're using the right timezone; it may be not up
          # to date in the current environment during the very 1st run
          # from run-docker-compose-on-boot.sh.
          source /etc/environment
          export TZ

          # Load private and public keys from Secrets Manager to ~/.ssh.
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          aws secretsmanager get-secret-value \\
            --secret-id "${keyPairPrivateKeySecretName}" \\
            --query SecretString --output text \\
            > ~/.ssh/ci-storage
          chmod 600 ~/.ssh/ci-storage
          ssh-keygen -f ~/.ssh/ci-storage -y > ~/.ssh/ci-storage.pub

          # Load GitHub PAT from Secrets Manager and log in to GitHub.
          aws secretsmanager get-secret-value \\
            --secret-id "${ghTokenSecretName}" \\
            --query SecretString --output text \\
            | gh auth login --with-token
          gh auth setup-git

          # Log in to ghcr.io every hour.
          config=~/.docker/config.json
          if [[ ! -f $config ]] || find "$config" -type f -mmin +60 | grep -q .; then
            gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
          fi

          # Pull the repository.
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

          # Process some tokens and print rate limits without xtrace.
          set +o xtrace
          GH_TOKEN=$(gh auth token)
          echo "Docker Hub Rate Limits:"
          docker_hub_token=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull" | jq -r .token || true)
          curl -s --head -H "Authorization: Bearer $docker_hub_token" https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest | grep ratelimit || true
          echo "GitHub Core Rate Limits:"
          gh api -i -X HEAD /rate_limit | grep Ratelimit
          set -o xtrace

          # Export env vars for docker compose.
          export GH_TOKEN
          ${Object.entries(dockerComposeEnv)
            .map(([k, v]) => `export ${k}="${v}"`)
            .join("\n")}

          # It it's the very 1st run, start Docker service. We do not start it every run,
          # because otherwise we wouldn't be able to "systemctl stop docker docker.socket"
          # manually or while copying files from the old host.
          file=~/.docker-started-after-first-git-clone
          if [[ ! -f $file ]]; then
            sudo systemctl start docker docker.socket
            touch $file
          fi

          # Run docker compose.
          cd "${path}"
          docker pull ghcr.io/dimikot/ci-storage:main || true
          docker pull ghcr.io/dimikot/ci-runner:main || true
          docker compose ${dockerComposeProfiles.map((profile) => `--profile=${profile} `).join("")}up --build --remove-orphans -d
          sleep 5
          if [[ "$1" != "--no-logs" ]]; then
            docker compose logs -n 10
          fi
          docker system prune --volumes -f
        `),
      },
      {
        path: "/home/ubuntu/.bash_profile",
        owner: "ubuntu:ubuntu",
        permissions: "0644",
        defer: true,
        content: dedent(`
          #!/bin/bash
          C_CMD="\\033[0;36m"
          C_NO="\\033[0m"
          if [[ -d ~/git/"${path}" ]]; then
            cd ~/git/"${path}"
            echo -e "$C_CMD\\$ docker compose ps$C_NO"
            docker --log-level=ERROR compose ps --format="table {{.Service}}\\t{{.Status}}\\t{{.Ports}}"
            services=$(docker compose ps --format '{{.Service}}' 2>/dev/null)
            if [[ "$services" != "" && $(echo "$services" | wc -l) -eq 1 ]]; then
              cmd="docker compose exec $services bash -l"
              echo -e "$C_CMD\\$ $cmd$C_NO"
              eval "$cmd"
            fi
          fi
        `),
      },
    ]),
  };
}
