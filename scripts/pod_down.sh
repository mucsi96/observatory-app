#!/usr/bin/env bash
set -euo pipefail
if podman pod exists observatory-app-test; then podman pod rm --force observatory-app-test; fi
