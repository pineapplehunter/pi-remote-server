{
  description = "Pi remote gateway and Docker-compatible OCI image";

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
          # Include the manifests in the name so lockfile changes cannot silently
          # reuse an old fixed-output store path with the same output hash.
          dependencyKey = builtins.substring 0 12 (
            builtins.hashString "sha256" (builtins.readFile ./package.json + builtins.readFile ./bun.lock)
          );
          runtimeDependencies = pkgs.stdenvNoCC.mkDerivation {
            name = "pi-remote-runtime-deps-${dependencyKey}";
            src = pkgs.runCommand "pi-remote-manifests" { } ''
              mkdir -p $out
              cp ${./package.json} $out/package.json
              cp ${./bun.lock} $out/bun.lock
            '';
            nativeBuildInputs = [ pkgs.bun ];
            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR"
              export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
              bun install --production --frozen-lockfile --ignore-scripts --no-cache
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              cp -R node_modules $out
              runHook postInstall
            '';
            dontFixup = true;
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-Uk3iQXzxYPNpdkLVm3b6iuB29+PqXtquBZ+5zFUguRE=";
          };
          app = pkgs.runCommand "pi-remote-app" { } ''
            mkdir -p $out/app
            cp -r ${./src} $out/app/src
            cp -r ${./public} $out/app/public
            cp ${./package.json} $out/app/package.json
            ln -s ${runtimeDependencies} $out/app/node_modules
          '';
        in
        {
          packages = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux rec {
            default = docker;
            docker = pkgs.dockerTools.streamLayeredImage {
              name = "pi-remote-server";
              tag = "latest";
              contents = [
                pkgs.bun
                pkgs.cacert
                app
              ];
              config = {
                Cmd = [
                  "${pkgs.bun}/bin/bun"
                  "src/index.ts"
                ];
                WorkingDir = "/app";
                Env = [
                  "HOST=0.0.0.0"
                  "PORT=3000"
                  "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
                ];
                ExposedPorts = {
                  "3000/tcp" = { };
                };
              };
            };
            runtime-dependencies = runtimeDependencies;
          };

          devShells.default = pkgs.mkShell {
            packages = [ pkgs.bun ];
          };

          formatter = pkgs.nixfmt-tree;
        };
    };
}
