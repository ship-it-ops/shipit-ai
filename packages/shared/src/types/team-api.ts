export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  description: string | null;
  ownedCount: number;
  memberCount: number;
  onCallCount: number;
}

export interface TeamOwnedEntity {
  id: string;
  name: string;
  label: string;
  tier: number | null;
  environment?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  login: string;
  role: string | null;
}

export interface OnCallAssignment {
  serviceId: string;
  serviceName: string;
  personId: string;
  personName: string;
}

export interface TeamDetail extends TeamSummary {
  services: TeamOwnedEntity[];
  repositories: TeamOwnedEntity[];
  deployments: TeamOwnedEntity[];
  members: TeamMember[];
  onCall: OnCallAssignment[];
}
