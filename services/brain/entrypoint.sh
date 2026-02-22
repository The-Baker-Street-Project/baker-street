#!/bin/sh
set -e

exec node --import ./services/brain/dist/instrument.js services/brain/dist/index.js
