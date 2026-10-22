/**
 * Built-in control catalogues: identifiers with short, neutral topic names written for Steward.
 *
 * The texts of ISO/IEC 27001 and IEC 62443 are copyrighted and are NOT included. Administrators can
 * add the wording their organisation licensed (or its own control descriptions) by editing a control
 * or importing a catalogue (JSON, YAML or CSV). NIS2 is EU law; its points are paraphrased as well.
 */

export interface BuiltinCatalogue {
  key: string;
  name: string;
  version: string;
  description: string;
  controls: { ref: string; title: string }[];
}

const iso = (ref: string, title: string) => ({ ref, title });

export const ISO27001: BuiltinCatalogue = {
  key: 'ISO27001',
  name: 'ISO/IEC 27001:2022 Annex A',
  version: '2022',
  description:
    'Control identifiers of ISO/IEC 27001:2022 Annex A with short topic names written for Steward. The standard’s text is not included – add your licensed wording by editing or importing the catalogue.',
  controls: [
    iso('5.1', 'information security policies'),
    iso('5.2', 'security roles and responsibilities'),
    iso('5.3', 'segregation of duties'),
    iso('5.4', 'management responsibilities'),
    iso('5.5', 'contact with authorities'),
    iso('5.6', 'contact with special interest groups'),
    iso('5.7', 'threat intelligence'),
    iso('5.8', 'security in project management'),
    iso('5.9', 'inventory of information and assets'),
    iso('5.10', 'acceptable use of information and assets'),
    iso('5.11', 'return of assets'),
    iso('5.12', 'classification of information'),
    iso('5.13', 'labelling of information'),
    iso('5.14', 'information transfer'),
    iso('5.15', 'access control'),
    iso('5.16', 'identity management'),
    iso('5.17', 'authentication information'),
    iso('5.18', 'access rights'),
    iso('5.19', 'security in supplier relationships'),
    iso('5.20', 'security in supplier agreements'),
    iso('5.21', 'ICT supply chain security'),
    iso('5.22', 'monitoring and review of supplier services'),
    iso('5.23', 'security for cloud services'),
    iso('5.24', 'incident management planning'),
    iso('5.25', 'assessment of security events'),
    iso('5.26', 'response to security incidents'),
    iso('5.27', 'learning from security incidents'),
    iso('5.28', 'collection of evidence'),
    iso('5.29', 'security during disruption'),
    iso('5.30', 'ICT readiness for business continuity'),
    iso('5.31', 'legal, statutory, regulatory and contractual requirements'),
    iso('5.32', 'intellectual property rights'),
    iso('5.33', 'protection of records'),
    iso('5.34', 'privacy and protection of personal data'),
    iso('5.35', 'independent review of information security'),
    iso('5.36', 'compliance with policies and standards'),
    iso('5.37', 'documented operating procedures'),
    iso('6.1', 'screening'),
    iso('6.2', 'terms of employment'),
    iso('6.3', 'security awareness and training'),
    iso('6.4', 'disciplinary process'),
    iso('6.5', 'responsibilities after termination or change of employment'),
    iso('6.6', 'confidentiality agreements'),
    iso('6.7', 'remote working'),
    iso('6.8', 'reporting of security events'),
    iso('7.1', 'physical security perimeters'),
    iso('7.2', 'physical entry'),
    iso('7.3', 'securing offices and facilities'),
    iso('7.4', 'physical security monitoring'),
    iso('7.5', 'protection against physical and environmental threats'),
    iso('7.6', 'working in secure areas'),
    iso('7.7', 'clear desk and clear screen'),
    iso('7.8', 'equipment siting and protection'),
    iso('7.9', 'security of assets off-premises'),
    iso('7.10', 'storage media'),
    iso('7.11', 'supporting utilities'),
    iso('7.12', 'cabling security'),
    iso('7.13', 'equipment maintenance'),
    iso('7.14', 'secure disposal or re-use of equipment'),
    iso('8.1', 'user endpoint devices'),
    iso('8.2', 'privileged access rights'),
    iso('8.3', 'restriction of access to information'),
    iso('8.4', 'access to source code'),
    iso('8.5', 'secure authentication'),
    iso('8.6', 'capacity management'),
    iso('8.7', 'protection against malware'),
    iso('8.8', 'management of technical vulnerabilities'),
    iso('8.9', 'configuration management'),
    iso('8.10', 'deletion of information'),
    iso('8.11', 'data masking'),
    iso('8.12', 'data leakage prevention'),
    iso('8.13', 'backup of information'),
    iso('8.14', 'redundancy of processing facilities'),
    iso('8.15', 'logging'),
    iso('8.16', 'monitoring activities'),
    iso('8.17', 'clock synchronisation'),
    iso('8.18', 'use of privileged utility programs'),
    iso('8.19', 'installation of software on operational systems'),
    iso('8.20', 'network security'),
    iso('8.21', 'security of network services'),
    iso('8.22', 'segregation of networks'),
    iso('8.23', 'web filtering'),
    iso('8.24', 'use of cryptography'),
    iso('8.25', 'secure development life cycle'),
    iso('8.26', 'application security requirements'),
    iso('8.27', 'secure system architecture and engineering'),
    iso('8.28', 'secure coding'),
    iso('8.29', 'security testing in development and acceptance'),
    iso('8.30', 'outsourced development'),
    iso('8.31', 'separation of development, test and production environments'),
    iso('8.32', 'change management'),
    iso('8.33', 'test information'),
    iso('8.34', 'protection of information systems during audit testing'),
  ],
};

export const IEC62443_2_1: BuiltinCatalogue = {
  key: 'IEC62443-2-1',
  name: 'IEC 62443-2-1 (CSMS elements)',
  version: '2010',
  description:
    'Element identifiers of the cyber security management system (CSMS) in IEC 62443-2-1:2010 with short topic names written for Steward. The standard’s text is not included. Edition 2 (2024) reorganised the requirements into security program elements – import your own catalogue if you work with it.',
  controls: [
    iso('4.2.2', 'business rationale'),
    iso('4.2.3', 'risk identification, classification and assessment'),
    iso('4.3.2.2', 'CSMS scope'),
    iso('4.3.2.3', 'organizing for security'),
    iso('4.3.2.4', 'staff training and security awareness'),
    iso('4.3.2.5', 'business continuity plan'),
    iso('4.3.2.6', 'security policies and procedures'),
    iso('4.3.3.2', 'personnel security'),
    iso('4.3.3.3', 'physical and environmental security'),
    iso('4.3.3.4', 'network segmentation'),
    iso('4.3.3.5', 'access control – account administration'),
    iso('4.3.3.6', 'access control – authentication'),
    iso('4.3.3.7', 'access control – authorization'),
    iso('4.3.4.2', 'risk management and implementation'),
    iso('4.3.4.3', 'system development and maintenance'),
    iso('4.3.4.4', 'information and document management'),
    iso('4.3.4.5', 'incident planning and response'),
    iso('4.4.2', 'conformance'),
    iso('4.4.3', 'review, improve and maintain the CSMS'),
  ],
};

export const NIS2: BuiltinCatalogue = {
  key: 'NIS2',
  name: 'NIS2 Directive Art. 21(2)',
  version: '(EU) 2022/2555',
  description: 'The cybersecurity risk-management measures of Article 21(2) of Directive (EU) 2022/2555 (NIS2), paraphrased.',
  controls: [
    iso('21(2)(a)', 'risk analysis and information system security policies'),
    iso('21(2)(b)', 'incident handling'),
    iso('21(2)(c)', 'business continuity, backup management, disaster recovery and crisis management'),
    iso('21(2)(d)', 'supply chain security'),
    iso('21(2)(e)', 'security in acquisition, development and maintenance, including vulnerability handling'),
    iso('21(2)(f)', 'assessing the effectiveness of risk-management measures'),
    iso('21(2)(g)', 'basic cyber hygiene and training'),
    iso('21(2)(h)', 'cryptography and encryption'),
    iso('21(2)(i)', 'human resources security, access control policies and asset management'),
    iso('21(2)(j)', 'multi-factor authentication, secured communications and emergency communications'),
  ],
};

export const BUILTIN_CATALOGUES = [ISO27001, IEC62443_2_1, NIS2];

/** Default mapping of Steward's own evidence: the access change type and access checks. */
export const DEFAULT_ACCESS_CONTROLS: { catalogue: string; ref: string }[] = [
  { catalogue: 'ISO27001', ref: '5.15' },
  { catalogue: 'ISO27001', ref: '5.16' },
  { catalogue: 'ISO27001', ref: '5.18' },
  { catalogue: 'ISO27001', ref: '8.2' },
  { catalogue: 'IEC62443-2-1', ref: '4.3.3.5' },
  { catalogue: 'IEC62443-2-1', ref: '4.3.3.7' },
  { catalogue: 'NIS2', ref: '21(2)(i)' },
];
