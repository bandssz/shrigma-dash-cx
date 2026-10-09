package main

import (
	"net/http"
	"strings"

	"github.com/knadh/listmonk/internal/auth"
	"github.com/labstack/echo/v4"
)

const campaignScanDiagnosticPath = "/api/internal/campaign-scan-diagnostic"

// campaignScanTokenOnly runs BEFORE the unchanged original auth middleware.
// Excluding cookies prevents the original session-auth branch from performing
// a session lookup. Only the original cached API-token auth path is admitted.
func campaignScanTokenOnly(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "no-store")
		if len(c.Request().Header.Values("Cookie")) != 0 ||
			!strings.HasPrefix(strings.TrimSpace(c.Request().Header.Get("Authorization")), "token ") {
			return echo.NewHTTPError(http.StatusForbidden, "diagnostic API token required")
		}
		return next(c)
	}
}

// registerCampaignScanDiagnostic uses the same original Auth.Middleware and
// settings:get permission. It creates no actor, role, credential or grant.
func registerCampaignScanDiagnostic(e *echo.Echo, authentication *auth.Auth) {
	g := e.Group("", campaignScanTokenOnly, authentication.Middleware)
	g.GET(campaignScanDiagnosticPath,
		authentication.Perm(campaignScanDiagnosticRead(&campaignScanLastFailure), "settings:get"))
}

func campaignScanDiagnosticRead(s *campaignScanSnapshotStore) echo.HandlerFunc {
	return func(c echo.Context) error {
		// Original Perm delegates invalid contexts to the next handler; reject
		// them here, and require an enabled API identity rather than a session.
		u, ok := c.Get(auth.UserHTTPCtxKey).(auth.User)
		if !ok || u.Type != auth.UserTypeAPI || u.Status != auth.UserStatusEnabled {
			return echo.NewHTTPError(http.StatusForbidden, "diagnostic API identity required")
		}
		_, permitted := u.PermissionsMap["settings:get"]
		if u.UserRole.ID != auth.SuperAdminRoleID && !permitted {
			return echo.NewHTTPError(http.StatusForbidden, "diagnostic permission required")
		}
		c.Response().Header().Set("Cache-Control", "no-store")
		return c.JSON(http.StatusOK, struct {
			Data *campaignScanSnapshot `json:"data"`
		}{Data: s.read()})
	}
}
