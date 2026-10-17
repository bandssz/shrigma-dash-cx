package manager

import (
 "html/template"
 "testing"
 txttpl "text/template"
 "text/template/parse"
 "github.com/knadh/listmonk/models"
)

func TestRegularTemplateNilWalkerNoElse(t *testing.T) {
 cases := map[string]string{
  "if": `{{if .Enabled}}ok{{end}}`,
  "range": `{{range .Items}}{{.}}{{end}}`,
  "with": `{{with .Item}}{{.}}{{end}}`,
  "nested": `{{if .Enabled}}{{range .Items}}{{with .}}{{.}}{{end}}{{end}}{{end}}`,
 }
 for name, source := range cases {
  t.Run(name+"/text", func(t *testing.T) {
   tpl, err := txttpl.New("fixture").Parse(source)
   if err != nil { t.Fatal(err) }
   ids := map[string]struct{}{}
   for _, entry := range tpl.Templates() { walkRegularTemplateNode(entry.Tree.Root, ids) }
   if len(ids) != 0 { t.Fatalf("unexpected identifiers: %v", ids) }
  })
  t.Run(name+"/html", func(t *testing.T) {
   tpl, err := template.New("fixture").Parse(source)
   if err != nil { t.Fatal(err) }
   ids := map[string]struct{}{}
   for _, entry := range tpl.Templates() { walkRegularTemplateNode(entry.Tree.Root, ids) }
   if len(ids) != 0 { t.Fatalf("unexpected identifiers: %v", ids) }
  })
 }
}

func TestRegularTemplateNilWalkerTypedNil(t *testing.T) {
 nodes := map[string]parse.Node{
  "list": (*parse.ListNode)(nil), "action": (*parse.ActionNode)(nil),
  "pipe": (*parse.PipeNode)(nil), "command": (*parse.CommandNode)(nil),
  "identifier": (*parse.IdentifierNode)(nil), "chain": (*parse.ChainNode)(nil),
  "if": (*parse.IfNode)(nil), "range": (*parse.RangeNode)(nil),
  "with": (*parse.WithNode)(nil), "template": (*parse.TemplateNode)(nil),
 }
 for name, node := range nodes {
  t.Run(name, func(t *testing.T) {
   ids := map[string]struct{}{}
   walkRegularTemplateNode(node, ids)
   if len(ids) != 0 { t.Fatalf("nil node created identifiers: %v", ids) }
  })
 }
 t.Run("nil-interface", func(t *testing.T) { walkRegularTemplateNode(nil, map[string]struct{}{}) })
 t.Run("nil-root", func(t *testing.T) { tree := &parse.Tree{}; walkRegularTemplateNode(tree.Root, map[string]struct{}{}) })
}

func TestRegularTemplateNilWalkerForbiddenTraversal(t *testing.T) {
 cases := []struct { name, source, identifier string }{
  {"if-body", `{{if .Enabled}}{{now}}{{end}}`, "now"},
  {"range-body", `{{range .Items}}{{randAlphaNum 5}}{{end}}`, "randAlphaNum"},
  {"with-body", `{{with .Item}}{{date "2006" .}}{{end}}`, "date"},
  {"nested", `{{if .Enabled}}{{range .Items}}{{with .}}{{now}}{{end}}{{end}}{{end}}`, "now"},
  {"else", `{{if .Enabled}}ok{{else}}{{now}}{{end}}`, "now"},
  {"define-unused", `ok{{define "hidden"}}{{if .Enabled}}{{now}}{{end}}{{end}}`, "now"},
  {"define-invoked", `{{template "hidden" .}}{{define "hidden"}}{{with .Item}}{{now}}{{end}}{{end}}`, "now"},
  {"argument-pipeline", `{{printf "%s" (now)}}`, "now"},
 }
 funcs := txttpl.FuncMap{"now": func(...any) string { return "fixture" },
  "randAlphaNum": func(...any) string { return "fixture" }, "date": func(...any) string { return "fixture" }}
 for _, item := range cases {
  t.Run(item.name+"/text", func(t *testing.T) {
   tpl, err := txttpl.New("fixture").Funcs(funcs).Parse(item.source)
   if err != nil { t.Fatal(err) }
   ids := map[string]struct{}{}
   for _, entry := range tpl.Templates() { walkRegularTemplateNode(entry.Tree.Root, ids) }
   if _, found := ids[item.identifier]; !found { t.Fatalf("forbidden identifier %q not traversed", item.identifier) }
   if _, forbidden := regularForbiddenTemplateFunctions[item.identifier]; !forbidden { t.Fatal("policy no longer forbids identifier") }
  })
  t.Run(item.name+"/html", func(t *testing.T) {
   tpl, err := template.New("fixture").Funcs(template.FuncMap(funcs)).Parse(item.source)
   if err != nil { t.Fatal(err) }
   ids := map[string]struct{}{}
   for _, entry := range tpl.Templates() { walkRegularTemplateNode(entry.Tree.Root, ids) }
   if _, found := ids[item.identifier]; !found { t.Fatalf("forbidden identifier %q not traversed", item.identifier) }
   if _, forbidden := regularForbiddenTemplateFunctions[item.identifier]; !forbidden { t.Fatal("policy no longer forbids identifier") }
  })
 }
}

func TestRegularTemplateNilValidationSlots(t *testing.T) {
 cases := []struct { name, source string; blocked bool }{
  {"if-no-else", `{{if .Enabled}}ok{{end}}`, false},
  {"range-no-else", `{{range .Items}}{{.}}{{end}}`, false},
  {"with-no-else", `{{with .Item}}{{.}}{{end}}`, false},
  {"nested-forbidden", `{{if .Enabled}}{{range .Items}}{{with .}}{{now}}{{end}}{{end}}{{end}}`, true},
  {"unused-define-forbidden", `ok{{define "hidden"}}{{if .Enabled}}{{now}}{{end}}{{end}}`, true},
  {"else-forbidden", `{{if .Enabled}}ok{{else}}{{now}}{{end}}`, true},
 }
 for _, item := range cases {
  for _, slot := range []string{"subject", "body", "alt"} {
   t.Run(item.name+"/"+slot, func(t *testing.T) {
    campaign := &models.Campaign{}
    if slot == "subject" {
     tpl, err := txttpl.New("fixture").Funcs(txttpl.FuncMap{"now": func() string { return "fixture" }}).Parse(item.source)
     if err != nil { t.Fatal(err) }; campaign.SubjectTpl = tpl
    } else {
     tpl, err := template.New("fixture").Funcs(template.FuncMap{"now": func() string { return "fixture" }}).Parse(item.source)
     if err != nil { t.Fatal(err) }
     if slot == "body" { campaign.Tpl = tpl } else { campaign.AltBodyTpl = tpl }
    }
    err := (&Manager{}).validateRegularCampaign(campaign)
    if item.blocked {
     if err == nil || err.Error() != "regular delivery template function unavailable" { t.Fatalf("forbidden policy was not enforced: %v", err) }
    } else if err != nil { t.Fatalf("valid template refused: %v", err) }
   })
  }
 }
}

func TestRegularTemplateNilValidationNilTrees(t *testing.T) {
 for _, slot := range []string{"subject", "body", "alt"} {
  for _, part := range []string{"tree", "root"} {
   t.Run(slot+"/"+part, func(t *testing.T) {
    campaign := &models.Campaign{}
    if slot == "subject" {
     tpl, err := txttpl.New("fixture").Parse("fixture")
     if err != nil { t.Fatal(err) }
     if part == "tree" { tpl.Tree = nil } else { tpl.Tree.Root = nil }
     campaign.SubjectTpl = tpl
    } else {
     tpl, err := template.New("fixture").Parse("fixture")
     if err != nil { t.Fatal(err) }
     if part == "tree" { tpl.Tree = nil } else { tpl.Tree.Root = nil }
     if slot == "body" { campaign.Tpl = tpl } else { campaign.AltBodyTpl = tpl }
    }
    if err := (&Manager{}).validateRegularCampaign(campaign); err != nil { t.Fatalf("nil tree/root refused: %v", err) }
   })
  }
 }
}
