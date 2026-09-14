#!/usr/bin/env node
import { runDeploymentValidationCli } from '../dist/deployment/index.js';

process.exitCode = await runDeploymentValidationCli(process.argv.slice(2));
