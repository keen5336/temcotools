import * as configuration from "@/lib/label-configuration-service";
import * as files from "@/lib/admin-file-service";
export const adminActions = {
  "printing.configuration": { capability: "labels.read", description: "Read active managed printers/templates for a retained workflow", run: configuration.getOperatorLabelConfiguration },
  "printing.management": { capability: "labels.manage", description: "Read managed printer/template configuration", run: configuration.getManagedLabelConfiguration },
  "printing.printer.create": { capability: "labels.manage", description: "Create a managed printer destination", run: configuration.createPrinter },
  "printing.printer.update": { capability: "labels.manage", description: "Update a printer using its current version", run: configuration.updatePrinter },
  "printing.printer.enabled": { capability: "labels.manage", description: "Enable/disable a managed printer", run: configuration.setPrinterEnabled },
  "printing.template.create": { capability: "labels.manage", description: "Create a retained workflow template", run: configuration.createTemplate },
  "printing.template.update": { capability: "labels.manage", description: "Update a retained template using its current version", run: configuration.updateTemplate },
  "printing.template.default": { capability: "labels.manage", description: "Choose the sole active default template for its purpose", run: configuration.setDefaultTemplate },
  "printing.template.enabled": { capability: "labels.manage", description: "Enable/disable a retained template", run: configuration.setTemplateEnabled },
  "files.list": { capability: "files.manage", description: "List entries inside the configured shared file root", run: files.listAdminFiles },
  "files.download": { capability: "files.manage", description: "Download a bounded file as base64 with its fingerprint", run: files.downloadAdminFile },
  "files.upload": { capability: "files.manage", description: "Upload files with durable intent IDs and explicit fingerprint-bound replacement", run: files.uploadAdminFiles },
  "files.directory.create": { capability: "files.manage", description: "Create a directory inside the configured root", run: files.createAdminDirectory },
  "files.move": { capability: "files.manage", description: "Move/rename the current fingerprint-bound shared entry", run: files.moveAdminFile },
  "files.delete": { capability: "files.manage", description: "Delete a fingerprint-bound entry; root and escaped links remain protected", run: files.deleteAdminFile },
} as const;
