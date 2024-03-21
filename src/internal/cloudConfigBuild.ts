import compact from "lodash/compact";
import { dedent } from "./dedent";

/**
 * Builds a reusable and never changing cloud config to be passed to the
 * instance's CloudInit service.
 */
export function cloudConfigBuild({
  fqdn,
  ghTokenSecretName,
  ghDockerComposeDirectoryUrl,
  keyPairPrivateKeySecretName,
  timeZone,
  mount,
}: {
  fqdn: string;
  ghTokenSecretName: string;
  ghDockerComposeDirectoryUrl: string;
  keyPairPrivateKeySecretName: string;
  timeZone: string | undefined;
  mount: { volumeId: string; path: string } | undefined;
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
  const preamble =
    'set -e -o pipefail && echo --- && echo "Running $BASH_SOURCE as $(whoami)" && set -o xtrace';

  return {
    timezone: timeZone,
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
      "tzdata",
    ],
    write_files: compact([
      {
        path: "/etc/sysctl.d/enable-ipv4-forwarding.conf",
        content: dedent(`
          net.ipv4.conf.all.forwarding=1
        `),
      },
      {
        path: "/etc/sysctl.d/lower-fs-inodes-eviction-from-cache.conf",
        content: dedent(`
          vm.vfs_cache_pressure=0
          vm.swappiness=10
        `),
      },
      timeZone && {
        path: "/var/lib/cloud/scripts/per-once/define-tz-env.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}

          echo 'TZ="${timeZone}"' >> /etc/environment
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
      mount && {
        path: "/var/lib/cloud/scripts/per-once/detach-volume-from-old-instance-and-mount.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}

          export AWS_DEFAULT_REGION=$(ec2metadata --availability-zone | sed "s/[a-z]$//")
          volume_id="${mount.volumeId}"
          volume_hash="\${volume_id##vol-}"
          volume_dir="/mnt"
          volume_label="MNT"
          instance_id=$(ec2metadata --instance-id)

          # Stop the old instances. This causes a small downtime of the host
          # service, but it's acceptable for the CI use case.
          old_instance_id=$(
            aws ec2 describe-volumes \\
              --volume-ids "$volume_id" \\
              --query "Volumes[].Attachments[].InstanceId" \\
              --output text
          )
          if [[ "$old_instance_id" != "" ]]; then
            sent_command=0
            while ! aws ec2 describe-instances \\
              --instance-ids "$old_instance_id" \\
              --query "Reservations[].Instances[].State.Name" \\
              --output text \\
              | egrep -q "stopped|terminated"
            do
              if [[ "$sent_command" == "0" ]]; then
                sent_command=1
                aws ec2 stop-instances --instance-ids "$old_instance_id" || true
              fi
              sleep 1
            done
          fi

          # Detach volume from the old instance.
          sent_command=0
          while ! aws ec2 describe-volumes \\
            --volume-ids "$volume_id" \\
            --query "Volumes[].State" \\
            --output text \\
            | grep -q available
          do
            if [[ "$sent_command" == "0" ]]; then
              sent_command=1
              aws ec2 detach-volume --volume-id "$volume_id" --force || true
            fi
            sleep 0.2;
          done

          # Attach volume to this instance and wait for the device to appear.
          sent_command=0
          while ! ls /dev/disk/by-id | grep -q "$volume_hash"; do
            if [[ "$sent_command" == "0" ]]; then
              sent_command=1
              aws ec2 attach-volume --volume-id "$volume_id" --instance-id "$instance_id" --device /dev/sdf
            fi
            sleep 0.2
          done

          # Mount volume if it already exists, or create the filesystem.
          lsblk
          ls -la /dev/disk/by-id
          device=$(echo /dev/disk/by-id/*$volume_hash)
          if ! grep -q "LABEL=$volume_label" /etc/fstab; then
            echo "LABEL=$volume_label $volume_dir auto defaults,noatime,data=writeback 0 0" >> /etc/fstab
          fi
          mount -a || true
          if ! mountpoint "$volume_dir"; then
            mkfs -t ext4 "$device"
            tune2fs -L "$volume_label" "$device"
            mount -a
            systemctl stop docker docker.socket
            ls -la /var/lib/docker
            cp -axT /var/lib/docker "$volume_dir/var_lib_docker"
            mv -f /var/lib/docker /var/lib/docker.old
            ln -sT "$volume_dir/var_lib_docker" /var/lib/docker
            systemctl start docker docker.socket
          fi
          ls -la "$volume_dir"
        `),
      },
      {
        path: "/var/lib/cloud/scripts/per-boot/run-docker-compose-on-boot.sh",
        permissions: "0755",
        content: dedent(`
          #!/bin/bash
          ${preamble}

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

          # Switch to non-privileged user if running as root.
          if [[ $(whoami) != "ubuntu" ]]; then
            exec gosu ubuntu:ubuntu "$BASH_SOURCE"
          fi

          # Ensure there is only one instance of this script running.
          exec {FD}<$BASH_SOURCE
          flock -n "$FD" || { echo "Already running."; exit 0; }
          ${preamble}

          # Load private and public keys from Secrets Manager to ~/.ssh.
          export AWS_DEFAULT_REGION=$(ec2metadata --availability-zone | sed "s/[a-z]$//")
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          aws secretsmanager get-secret-value \\
            --secret-id "${keyPairPrivateKeySecretName}" \\
            --query SecretString --output text \\
            > ~/.ssh/ci-storage
          chmod 600 ~/.ssh/ci-storage
          ssh-keygen -f ~/.ssh/ci-storage -y > ~/.ssh/ci-storage.pub

          # Load GitHub PAT from Secrets Manager and login to GitHub.
          aws secretsmanager get-secret-value \\
            --secret-id "${ghTokenSecretName}" \\
            --query SecretString --output text \\
            | gh auth login --with-token
          gh auth setup-git

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

          # Run docker compose.
          sudo usermod -aG docker ubuntu
          export GH_TOKEN
          set +o xtrace
          GH_TOKEN=$(gh auth token)
          set -o xtrace
          exec sg docker -c 'cd "${path}" && docker compose pull && exec docker compose up --build -d'
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
            docker --log-level=ERROR compose ps --format="table {{.Service}}\\t{{.Status}}\\t{{.Ports}}"
            echo
          fi
        `),
      },
    ]),
  };
}
