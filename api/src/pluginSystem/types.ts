export type JsonSchemaProperty = {
  type?: 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
};

export type PluginAction = {
  id: string;
  name: string;
  description?: string;
  export: string;
  inputSchema?: {
    type?: 'object';
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
};

export type PluginPermission = {
  reason?: string;
};

export type PluginHttpPermission = PluginPermission & {
  requiredHosts?: string[];
};

export type PluginKVPermission = PluginPermission & {
  maxSize?: string;
};

export type NdpManifest = {
  id?: string;
  name: string;
  author: string;
  version: string;
  description?: string;
  homepage?: string;
  website?: string;
  config?: {
    schema?: {
      type?: 'object';
      properties?: Record<string, JsonSchemaProperty>;
      required?: string[];
      additionalProperties?: boolean;
    };
    uiSchema?: unknown;
  };
  permissions?: {
    config?: PluginPermission;
    http?: PluginHttpPermission;
    kvstore?: PluginKVPermission;
    storage?: PluginPermission;
    [key: string]: unknown;
  };
  mvbar?: {
    actions?: PluginAction[];
  };
  [key: string]: unknown;
};

export type ParsedPluginPackage = {
  id: string;
  filename: string;
  manifest: NdpManifest;
  wasm: Buffer;
  exports: string[];
  packageSha256: string;
  permissionFingerprint: string;
};

export type PluginDbRow = {
  id: string;
  filename: string;
  name: string;
  author: string;
  version: string;
  description: string | null;
  homepage: string | null;
  manifest: NdpManifest;
  config: Record<string, unknown>;
  enabled: boolean;
  package_sha256: string;
  permission_fingerprint: string;
  installed_at: string | Date;
  updated_at: string | Date;
  last_loaded_at: string | Date | null;
  last_error: string | null;
};

export type PluginLogEntry = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
};
