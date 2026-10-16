{
  description = "Pi remote Go gateway and Docker-compatible OCI image";

  inputs.nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  inputs.flake-parts.url = "github:hercules-ci/flake-parts";

  outputs =
    { flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem =
        { pkgs, ... }:
        let
          server = pkgs.buildGoModule {
            pname = "pi-remote-server";
            version = "0.1.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                (pkgs.lib.fileset.fileFilter (file: file.hasExt "go") ./.)
                ./go.mod
                ./go.sum
                ./templates
                ./public
              ];
            };
            vendorHash = "sha256-0Qxw+MUYVgzgWB8vi3HBYtVXSq/btfh4ZfV/m1chNrA=";
            subPackages = [ "." ];
            env.CGO_ENABLED = "0";
            ldflags = [
              "-s"
              "-w"
            ];
            meta.mainProgram = "pi-remote-server";
          };
          extensionManifest = builtins.fromJSON (builtins.readFile ./pi-extension/package.json);
          extensionLock = builtins.fromJSON (builtins.readFile ./pi-extension/package-lock.json);
          ws = extensionLock.packages."node_modules/ws";
          wsSource = pkgs.fetchurl {
            url = ws.resolved;
            hash = ws.integrity;
          };
          piExtension =
            # ws has no mandatory transitive dependencies. Fail if the package
            # gains another runtime dependency instead of silently omitting it.
            assert builtins.attrNames extensionManifest.dependencies == [ "ws" ];
            pkgs.runCommand "pi-remote-extension" { } ''
              mkdir -p $out/node_modules/ws
              cp -r ${./pi-extension/extensions} $out/extensions
              cp ${./pi-extension/package.json} $out/package.json
              cp ${./pi-extension/PROTOCOL.md} $out/PROTOCOL.md
              cp ${./pi-extension/README.md} $out/README.md
              tar -xzf ${wsSource} --strip-components=1 -C $out/node_modules/ws
            '';
        in
        {
          packages = {
            inherit server;
            pi-extension = piExtension;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux rec {
            default = docker;
            docker = pkgs.dockerTools.streamLayeredImage {
              name = "pi-remote-server";
              tag = "latest";
              contents = [ server ];
              config = {
                Cmd = [ "${server}/bin/pi-remote-server" ];
                WorkingDir = "/";
                Env = [
                  "HOST=0.0.0.0"
                  "PORT=3000"
                ];
                ExposedPorts = {
                  "3000/tcp" = { };
                };
              };
            };
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.go
              pkgs.bun
              pkgs.nodejs
            ];
          };

          formatter = pkgs.nixfmt-tree;
        };
    };
}
