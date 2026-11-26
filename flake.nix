{
  description = "Pi remote Go gateway and Docker-compatible OCI image";

  inputs.nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  inputs.flake-parts.url = "github:hercules-ci/flake-parts";

  outputs =
    { flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem =
        { pkgs, ... }:
        let
          server = pkgs.callPackage ./go-server.nix { };
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
            docker = pkgs.callPackage ./docker.nix { inherit server; };
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.go
              pkgs.tailwindcss_4
              pkgs.bun
              pkgs.nodejs
              pkgs.openssl
              pkgs.openssh
              pkgs.sqlite
            ];
          };

          formatter = pkgs.nixfmt-tree;
        };
    };
}
