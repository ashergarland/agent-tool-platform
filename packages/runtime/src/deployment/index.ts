export {
  CANONICAL_CAPABILITY_DECLARATION_PATH,
  accessDimensions,
  capabilityProfileDeclarationJsonSchema,
  capabilityProfileDeclarationSchema,
  capabilityProfileSchema,
  deliveryDimensions,
  deploymentArtifactSchema,
  deploymentInstanceJsonSchema,
  deploymentInstanceSchema,
  deploymentProfileDimensionsSchema,
  executionDimensions,
  mutationDimensions,
  providerDimensions,
  workloadDimensions,
  type CapabilityProfile,
  type CapabilityProfileDeclaration,
  type ContractJsonSchema,
  type DeploymentArtifact,
  type DeploymentInstance,
  type DeploymentProfileDimensions,
} from './schemas.js';

export {
  DeploymentValidationError,
  assertCapabilityProfileDeclaration,
  assertDeploymentContract,
  assertDeploymentInstance,
  validateCapabilityProfileDeclaration,
  validateDeploymentContract,
  validateDeploymentInstance,
  type DeploymentContractValidationInput,
  type DeploymentValidationResult,
} from './validate.js';

export { runDeploymentValidationCli, type DeploymentValidationCliIo } from './cli.js';
