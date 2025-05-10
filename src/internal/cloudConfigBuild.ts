import {
  bootCmdMountDisk,
  bootCmdMountSwap,
  bootCmdMountTmpfs,
  bootCmdSwitchSsmUserOnLogin,
} from "@clickup/instance-to-ami-cdk";
import compact from "lodash/compact";
import { dedent } from "./dedent";

// Cloud Config is precisely for this image (package names are different for
// different Ubuntu versions for instance). We also use the latest kernel, since
// it supports extended attributes on tmpfs (which are needed by rsync).
export const SSM_IMAGE_NAME_ARM64 =
  "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";

/**
 * Builds a reusable and never changing cloud config to be passed to the
 * instance's CloudInit service. This config is multi-purpose: it doesn't know
 * about the role of the instance (host or runner), it just initiates the
 * instance to run docker compose file on it.
 */
export function cloudConfigBuild({
  fqdn,
  ghTokenSecretName,
  dockerComposeEnv,
  dockerComposeProfiles,
  dockerComposePrePullImages,
  dockerComposeCmdAfter,
  ghDockerComposeDirectoryUrl,
  keyPairPrivateKeySecretName,
  timeZone,
  ephemeral,
  tmpfs,
  swapSizeGb,
  logGroupName,
}: {
  fqdn: string | undefined;
  ghTokenSecretName: string;
  ghDockerComposeDirectoryUrl: string;
  dockerComposeEnv: Record<string, string>;
  dockerComposeProfiles: string[];
  dockerComposePrePullImages: Array<{
    repo: string;
    image: string;
    tags: string[];
  }>;
  dockerComposeCmdAfter: string | null;
  keyPairPrivateKeySecretName: string;
  timeZone: string | undefined;
  ephemeral: { path: string; chown: string; chmod: string } | undefined;
  tmpfs:
    | { path: string; chmod: string; maxSizeGb?: number | string }
    | undefined;
  swapSizeGb: number | undefined;
  logGroupName: string;
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
    "echo \"================= $(date) | Up $(awk '{print $1}' /proc/uptime) seconds =================\"",
    'echo "Running $BASH_SOURCE as $(whoami)"',
    "set -x",
    'export AWS_DEFAULT_REGION=$(ec2metadata --availability-zone | sed "s/[a-z]$//")',
  ].join(" && ");

  return {
    timezone: timeZone,
    fqdn: fqdn || undefined,
    hostname: fqdn || undefined,
    // Debugging when booting from a snapshot:
    //
    // - https://github.com/canonical/cloud-init/blob/main/cloudinit/config/cc_disk_setup.py
    // - issues with EBS: `lsblk`
    // - some service deps: `systemd-analyze critical-chain docker.service`
    // - boot logs: `journalctl -b -o short-iso`
    // - cloud-init output logs: `less /var/log/cloud-init-output.log`
    // - cloud-init steps logs: `less /var/log/cloud-init.log`
    //
    // Notice that bootcmd runs very early, even before disk_setup and
    // write_files directives.
    bootcmd: compact([
      bootCmdSwitchSsmUserOnLogin(),
      tmpfs && bootCmdMountTmpfs(tmpfs),
      ephemeral &&
        bootCmdMountDisk({
          label: "ephemeral",
          path: ephemeral.path,
          chown: ephemeral.chown,
          chmod: ephemeral.chmod,
          initOnceCmd: `cp -af ".${ephemeral.path}/." "${ephemeral.path}"`,
        }),
      "mkdir -p /var/log/atop",
      swapSizeGb &&
        bootCmdMountSwap({
          path: `${ephemeral?.path ?? "/var"}/swapfile`,
          sizeGb: swapSizeGb,
        }),
    ]),
    // Packages are installed after bootcmd and after write_files, but before
    // /var/lib/cloud/scripts/per-* scripts.
    apt: {
      sources: {
        "github-cli.list": {
          source: "deb https://cli.github.com/packages stable main",
          append: false,
          keyid: "23F3D4EA75716059",
        },
        "docker.list": {
          source:
            "deb https://download.docker.com/linux/ubuntu $RELEASE stable",
          append: false,
          keyid: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
        },
      },
    },
    packages: [
      "docker-ce=5:27.3.1-1~ubuntu.24.04~noble",
      "docker-ce-cli=5:27.3.1-1~ubuntu.24.04~noble",
      "containerd.io=1.7.23-1",
      "docker-compose-plugin=2.29.7-1~ubuntu.24.04~noble",
      "docker-buildx-plugin=0.17.1-1~ubuntu.24.04~noble",
      "qemu-system=1:8.2.2+ds-0ubuntu1.4",
      "qemu-user-static=1:8.2.2+ds-0ubuntu1.4",
      "gh",
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
      "expect",
    ],
    snap: {
      commands: {
        "0": "snap install aws-cli --classic",
      },
    },
    // Files are written after bootcmd, but before packages are installed.
    write_files: compact([
      //
      // Regular system files and configs.
      //
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
            "userns-remap": "sysbox",
            "max-concurrent-downloads": 10,
            "max-concurrent-uploads": 100
          }
        `),
      },
      {
        path: "/etc/systemd/system/docker.service.d/override.conf",
        permissions: "0644",
        content: dedent(`
          [Service]
          # Increase grace period for stopping containers.
          TimeoutStopSec=3600
          # Run docker compose ASAP after Docker starts.
          ExecStartPost=/home/ubuntu/run-docker-compose.sh --called-from-systemd
        `),
      },
      {
        path: "/etc/cron.d/git-pull-and-rerun-docker-compose-periodically",
        permissions: "0644",
        content: dedent(`
          */1 * * * * ubuntu /home/ubuntu/run-docker-compose.sh --no-print-compose-logs 2>&1 | logger -t docker/run-docker-compose
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
      //
      // Per-once scripts (change FS permanently before snapshot+image are
      // taken). Notice that they run in ~20 seconds after bootcmd, i.e. late.
      //
      {
        path: "/var/lib/cloud/scripts/per-once/00-append-etc-environment.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          ${timeZone ? `echo "TZ=${timeZone}" >> /etc/environment` : ""}
          echo "LESS=RS" >> /etc/environment
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/make-apt-get-install-not-run-after-restoring-from-snapshot-to-speedup-boot.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          sed -i -E 's/(- (package-update-upgrade-install|apt-configure|apt-pipelining))/# \\1/g' /etc/cloud/cloud.cfg
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-once/apply-services-configs.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          systemctl daemon-reload
          service atop restart || true
          sysctl --system
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
        // To debug crashes (like "program exceeds 10000-thread limit"):
        //
        // - sudo journalctl -u sysbox-fs.service
        // - sudo journalctl -u sysbox-mgr.service
        //
        // Also, if sysbox-fs crashes and gets restarted, it also tries to
        // restart sysbox-mgr (because otherwise, sysbox-mgr remains stopped:
        // something stops it gracefully on a sysbox-fs crash).
        content: dedent(`
          #!/bin/bash
          ${preamble}
          systemctl stop docker docker.socket || true
          for svc in sysbox-fs sysbox-mgr; do
            dir="/etc/systemd/system/$svc.service.d"
            mkdir -p "$dir"
            {
              echo "[Service]"
              echo "Restart=always"
              echo "RestartSec=5"
              if [[ "$svc" == "sysbox-fs" ]]; then
                echo "ExecStartPost=/bin/systemctl start sysbox-mgr.service"
              fi
            } > "$dir/override.conf"
          done
          version="0.6.6"
          wget -nv -O /tmp/sysbox-ce.deb "https://github.com/nestybox/sysbox/releases/download/v$version/sysbox-ce_$version-0.linux_$(dpkg --print-architecture).deb"
          dpkg -i /tmp/sysbox-ce.deb
          rm -f /tmp/sysbox-ce.deb
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
        path: "/var/lib/cloud/scripts/per-once/install-cloudwatch-agent.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          wget -nv -O /tmp/amazon-cloudwatch-agent.deb https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/$(dpkg --print-architecture)/latest/amazon-cloudwatch-agent.deb
          dpkg -i /tmp/amazon-cloudwatch-agent.deb
          systemctl enable amazon-cloudwatch-agent
        `),
      },
      //
      // Per-instance scripts (ran after an instance is re-created from a
      // snapshot).
      //
      {
        path: "/var/lib/cloud/scripts/per-instance/configure-cloudwatch.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}
          cat > /opt/aws/amazon-cloudwatch-agent/bin/config.json <<EOF
          {
            "agent": {
              "run_as_user": "root",
              "interval": "5s",
              "logfile": "/var/log/amazon-cloudwatch-agent"
            },
            "logs": {
              "logs_collected": {
                "files": {
                  "collect_list": [
                    {
                      "file_path": "/var/log/cloud-init.log",
                      "log_group_name": "${logGroupName}",
                      "log_stream_name": "$(ec2metadata --instance-id)/cloud-init.log",
                      "timezone": "LOCAL",
                      "retention_in_days": 7
                    },
                    {
                      "file_path": "/var/log/cloud-init-output.log",
                      "log_group_name": "${logGroupName}",
                      "log_stream_name": "$(ec2metadata --instance-id)/cloud-init-output.log",
                      "timezone": "LOCAL",
                      "retention_in_days": 7
                    },
                    {
                      "file_path": "/var/log/syslog",
                      "log_group_name": "${logGroupName}",
                      "log_stream_name": "$(ec2metadata --instance-id)/syslog",
                      "timezone": "LOCAL",
                      "retention_in_days": 7
                    }
                  ]
                }
              }
            }
          }
          EOF
          /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\
            -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json
          systemctl restart amazon-cloudwatch-agent
        `),
      },

      //
      // User scripts and tools (must have "defer=true" to be run after ubuntu
      // user is created).
      //
      {
        path: "/home/ubuntu/docker-pull-if-changed-rate-limit-friendly.sh",
        owner: "ubuntu:ubuntu",
        permissions: "0755",
        defer: true,
        content: dedent(String.raw`
          #!/bin/bash
          set -e -o pipefail
          repo="$1"
          name="$2"
          tag="$3"

          if [[ "$repo" == "" || "$name" == "" || "$tag" == "" ]]; then
            echo "Usage: $0 repo name tag"
            exit 1
          fi

          # In case of e.g. ghcr.io, it's actually base64("used:pat").
          bearer=$(jq -r ".auths[\"$repo\"].auth" ~/.docker/config.json || true)
          if [[ "$bearer" == "" ]]; then
            echo "There is no auth token for $repo in ~/.docker/config.json; did you run \"docker login\"?"
            exit 2
          fi

          file=~/.docker/$(echo "$repo-$name-$tag" | sed -E 's/[^-_a-zA-Z0-9]/_/g').digest
          old_digest=$(cat "$file" 2>/dev/null || true)
          cur_digest=$(
            curl -sS --fail --head \
              -H "Authorization: Bearer $bearer" \
              -H "Accept: application/vnd.oci.image.index.v1+json" \
              https://$repo/v2/$name/manifests/$tag \
              | grep -i 'Docker-Content-Digest' | awk '{print $2}' | sed -E 's/\s+//'
          )

          if [[ "$old_digest" != "$cur_digest" ]]; then
            if docker pull $repo/$name:$tag; then
              echo "$cur_digest" > $file
            else
              code="$?"
              echo "Failed to run \"docker pull $repo/$name:$tag\""
              exit "$code"
            fi
          else
            echo "Not pulling $repo/$name:$tag - no changes in manifest since previous pull (digest: $cur_digest)"
          fi
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
            | cat > ~/.ssh/ci-storage
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
          if [[ -d .git ]] && ! git fsck; then
            rm -rf ~/git/* ~/git/.*
          fi
          if [[ ! -d .git ]]; then
            git clone -n --depth=1 --filter=tree:0 ${branch ? `-b "${branch}"` : ""} "${repoUrl}" .
            if [[ "${path}" != "." ]]; then
              git sparse-checkout set --no-cone "${path}"
            fi
            git checkout
          else
            git pull --rebase
          fi

          # Export token without xtrace.
          { set +x; } &> /dev/null
          export GH_TOKEN=$(gh auth token)
          { set -x; } &> /dev/null

          # Export env vars for docker compose.
          export BTIME=$(cat /proc/stat | grep btime | awk '{print $2}')
          ${Object.entries(dockerComposeEnv)
            .map(([k, v]) => `export ${k}="${v}"`)
            .join("\n")}

          # Start Docker in case it crashed before.
          if [[ "$*" != *--called-from-systemd* ]]; then
            sudo systemctl daemon-reload
            sudo systemctl start docker docker.socket
          fi

          # Run docker compose.
          cd "${path}"
          ${dockerComposePrePullImages
            .flatMap(({ repo, image, tags }) =>
              tags.map(
                (tag) =>
                  `~/docker-pull-if-changed-rate-limit-friendly.sh "${repo}" "${image}" "${tag}"`,
              ),
            )
            .join("\n")}
          docker compose ${dockerComposeProfiles.map((profile) => `--profile=${profile} `).join("")}up --build --remove-orphans -d

          if [[ "$*" != *--no-print-compose-logs* ]]; then
            # Print logs before "docker system prune", otherwise they may be
            # empty in case the container failed to start. We can always look
            # at /var/log/syslog though.
            sleep 5
            docker compose logs -n 10
          fi

          docker system prune --volumes -f
          ${dockerComposeCmdAfter ?? ""}
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
            echo "Hint: want to know, how did this instance boot and how did"
            echo "the containers initialize? Run on the instance:"
            echo
            echo '$ less /var/log/cloud-init-output.log'
            echo '$ less /var/log/cloud-init.log'
            echo '$ less /var/log/syslog'
            echo
            echo -e "$C_CMD\\$ docker compose ps$C_NO"
            COLUMNS=500 docker --log-level=ERROR compose ps --format="table {{.Service}}\\t{{.Status}}\\t{{.Ports}}"
            echo
            services=$(docker compose ps --format '{{.Service}}' 2>/dev/null)
            if [[ "$services" != "" && $(echo "$services" | wc -l) -eq 1 ]]; then
              echo "Hint: only one service is running on this instance, $services."
              echo
              echo "For your convenience, we are automatically logging you in"
              echo "its container. Feel free to use any regular Linux commands"
              echo "(ls, pwd, mc etc.) or any dev tools."
              echo
              echo "You can alway exit back to the instance by pressing ^D."
              echo
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
