export type SecretConfig = {
	hosts: string[];
	value: string;
};

export type MountConfig = {
	host: string;
	guest: string;
	readOnly?: boolean;
};

export type PortMapping = {
	hostPort: number;
	containerPort: number;
	bindAddress?: string;
};

export type SandboxOptions = {
	image: string;
	allowNet?: string[];
	secrets?: Record<string, SecretConfig>;
	env?: Record<string, string>;
	mounts?: MountConfig[];
	portMappings?: PortMapping[];
	name?: string;
	debugInjectHeader?: boolean;
};

export type SandboxProfile = {
	image?: string;
	allowNet?: string[];
	secrets?: Record<string, SecretConfig>;
	env?: Record<string, string>;
	mounts?: MountConfig[];
	portMappings?: PortMapping[];
	name?: string;
	debugInjectHeader?: boolean;
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};
