{ dockerTools, server }:
dockerTools.streamLayeredImage {
  name = "pi-remote-server";
  tag = "latest";
  contents = [ server ];
  extraCommands = ''
    mkdir -p var/lib/pi-remote
    chmod 0700 var/lib/pi-remote
  '';
  config = {
    Cmd = [ "${server}/bin/pi-remote-server" ];
    WorkingDir = "/";
    Env = [
      "HOST=0.0.0.0"
      "PORT=3000"
      "PI_REMOTE_DB=/var/lib/pi-remote/hosts.sqlite"
    ];
    Volumes."/var/lib/pi-remote" = { };
    ExposedPorts = {
      "3000/tcp" = { };
    };
  };
}
