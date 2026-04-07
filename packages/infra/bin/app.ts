#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { SkyhookStack } from "../lib/skyhook-stack.js";

const app = new cdk.App();

new SkyhookStack(app, "SkyhookStack", {
  description: "Skyhook MCP reverse call flow proxy — ALB + Fargate",
});
