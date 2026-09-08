$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Project configuration was not found at:`r`n$envPath",
        "Emilia Roleplay Setup",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

function Save-RoleplayConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$ApiKey,
        [Parameter(Mandatory = $true)][string]$Model,
        [Parameter(Mandatory = $true)][string]$BaseUrl
    )

    $preserved = Get-Content $envPath | Where-Object { $_ -notmatch '^ROLEPLAY_' }
    $next = @($preserved) + @(
        "ROLEPLAY_ENABLED=true",
        "ROLEPLAY_BASE_URL=$BaseUrl",
        "ROLEPLAY_API_KEY=$ApiKey",
        "ROLEPLAY_MODEL=$Model",
        "ROLEPLAY_MAX_TOKENS=500",
        "ROLEPLAY_TEMPERATURE=0.85",
        "ROLEPLAY_TIMEOUT_MS=60000",
        "ROLEPLAY_CONTEXT_MESSAGES=20"
    )
    $temporaryPath = "$envPath.tmp"
    [IO.File]::WriteAllLines($temporaryPath, $next, (New-Object Text.UTF8Encoding($false)))
    Move-Item $temporaryPath $envPath -Force
    & icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
}

function Test-RoleplayConnection {
    param(
        [Parameter(Mandatory = $true)][string]$ApiKey,
        [Parameter(Mandatory = $true)][string]$Model,
        [Parameter(Mandatory = $true)][string]$BaseUrl
    )

    $headers = @{ Authorization = "Bearer $ApiKey" }
    $body = @{
        model = $Model
        messages = @(
            @{ role = "system"; content = "You are a connectivity test. Follow the user exactly." },
            @{ role = "user"; content = "Reply with exactly OK" }
        )
        max_tokens = 32
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 6 -Compress
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "$BaseUrl/chat/completions" `
        -Headers $headers `
        -ContentType "application/json; charset=utf-8" `
        -Body $body `
        -TimeoutSec 60
    $reply = [string]$response.choices[0].message.content
    if (-not $reply.Trim()) { throw "The model returned an empty reply." }
    return $reply.Trim()
}

function Get-RoleplayCandidates {
    param(
        [Parameter(Mandatory = $true)][string]$ApiKey,
        [Parameter(Mandatory = $true)][string]$SelectedModel
    )

    if ($ApiKey.StartsWith("sk-sp-")) {
        return @([pscustomobject]@{
            Name = "Token Plan (Beijing)"
            BaseUrl = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
            Model = $SelectedModel
            TokenPlan = $true
        })
    }
    return @(
        [pscustomobject]@{
            Name = "China (Beijing)"
            BaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
            Model = $SelectedModel
            TokenPlan = $false
        },
        [pscustomobject]@{
            Name = "International (Singapore)"
            BaseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            Model = $(if ($SelectedModel -eq "qwen-flash-character-2026-02-26") { "qwen-flash-character" } else { $SelectedModel })
            TokenPlan = $false
        }
    )
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Emilia - Roleplay Model Setup"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(560, 350)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Connect Qwen Character"
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 17)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(28, 24)
$form.Controls.Add($title)

$description = New-Object System.Windows.Forms.Label
$description.Text = "Paste the Alibaba Cloud Model Studio API key below. It stays on this PC and is stored in the protected Core configuration."
$description.Location = New-Object System.Drawing.Point(31, 66)
$description.Size = New-Object System.Drawing.Size(495, 44)
$form.Controls.Add($description)

$keyLabel = New-Object System.Windows.Forms.Label
$keyLabel.Text = "API Key"
$keyLabel.AutoSize = $true
$keyLabel.Location = New-Object System.Drawing.Point(31, 120)
$form.Controls.Add($keyLabel)

$keyBox = New-Object System.Windows.Forms.TextBox
$keyBox.Location = New-Object System.Drawing.Point(34, 145)
$keyBox.Size = New-Object System.Drawing.Size(405, 28)
$keyBox.UseSystemPasswordChar = $true
$form.Controls.Add($keyBox)

$pasteButton = New-Object System.Windows.Forms.Button
$pasteButton.Text = "Paste"
$pasteButton.Location = New-Object System.Drawing.Point(448, 143)
$pasteButton.Size = New-Object System.Drawing.Size(78, 31)
$pasteButton.Add_Click({
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $keyBox.Text = [System.Windows.Forms.Clipboard]::GetText().Trim()
        $statusLabel.Text = "Key pasted. Click Test and Save."
        $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(75, 75, 75)
    } else {
        $statusLabel.Text = "Clipboard has no text. Copy the key first."
        $statusLabel.ForeColor = [System.Drawing.Color]::Firebrick
    }
})
$form.Controls.Add($pasteButton)

$showBox = New-Object System.Windows.Forms.CheckBox
$showBox.Text = "Show key"
$showBox.AutoSize = $true
$showBox.Location = New-Object System.Drawing.Point(34, 180)
$showBox.Add_CheckedChanged({ $keyBox.UseSystemPasswordChar = -not $showBox.Checked })
$form.Controls.Add($showBox)

$modelLabel = New-Object System.Windows.Forms.Label
$modelLabel.Text = "Model"
$modelLabel.AutoSize = $true
$modelLabel.Location = New-Object System.Drawing.Point(31, 215)
$form.Controls.Add($modelLabel)

$modelBox = New-Object System.Windows.Forms.ComboBox
$modelBox.DropDownStyle = "DropDownList"
$modelBox.Location = New-Object System.Drawing.Point(98, 211)
$modelBox.Size = New-Object System.Drawing.Size(341, 30)
[void]$modelBox.Items.Add("qwen-flash-character-2026-02-26")
[void]$modelBox.Items.Add("qwen-flash-character")
[void]$modelBox.Items.Add("qwen-plus-character")
$modelBox.SelectedIndex = 0
$form.Controls.Add($modelBox)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Nothing has been changed yet."
$statusLabel.Location = New-Object System.Drawing.Point(31, 253)
$statusLabel.Size = New-Object System.Drawing.Size(495, 38)
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(75, 75, 75)
$form.Controls.Add($statusLabel)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Test and Save"
$saveButton.Location = New-Object System.Drawing.Point(309, 300)
$saveButton.Size = New-Object System.Drawing.Size(130, 36)
$saveButton.Add_Click({
    $apiKey = $keyBox.Text.Trim()
    if (-not $apiKey -or $apiKey -notmatch '^sk-[\x21-\x7E]+$') {
        $statusLabel.Text = "Paste a complete API key beginning with sk-."
        $statusLabel.ForeColor = [System.Drawing.Color]::Firebrick
        $keyBox.Focus()
        return
    }
    $saveButton.Enabled = $false
    $pasteButton.Enabled = $false
    $statusLabel.Text = "Testing the connection..."
    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(75, 75, 75)
    $form.Refresh()
    try {
        $selected = $null
        $errors = New-Object System.Collections.Generic.List[string]
        foreach ($candidate in (Get-RoleplayCandidates -ApiKey $apiKey -SelectedModel ([string]$modelBox.SelectedItem))) {
            $statusLabel.Text = "Testing $($candidate.Name)..."
            $form.Refresh()
            try {
                $reply = Test-RoleplayConnection -ApiKey $apiKey -Model $candidate.Model -BaseUrl $candidate.BaseUrl
                $selected = $candidate
                break
            } catch {
                $detail = $_.Exception.Message -replace '\s+', ' '
                if ($detail.Length -gt 90) { $detail = $detail.Substring(0, 90) + "..." }
                $errors.Add("$($candidate.Name): $detail")
            }
        }
        if (-not $selected) {
            if ($apiKey.StartsWith("sk-sp-")) {
                throw "This is a Token Plan key. Qwen Character needs a compatible Token Plan entitlement or a standard pay-as-you-go Model Studio key. $($errors -join ' | ')"
            }
            throw "The key did not match the Beijing or Singapore endpoint. Check which region created it and copy the complete Model Studio API key. $($errors -join ' | ')"
        }
        Save-RoleplayConfiguration -ApiKey $apiKey -Model $selected.Model -BaseUrl $selected.BaseUrl
        $keyBox.Clear()
        [System.Windows.Forms.Clipboard]::Clear()
        $statusLabel.Text = "Success via $($selected.Name). Configuration saved and clipboard cleared."
        $statusLabel.ForeColor = [System.Drawing.Color]::SeaGreen
        $saveButton.Text = "Saved"
    } catch {
        $message = $_.Exception.Message
        if ($message.Length -gt 170) { $message = $message.Substring(0, 170) + "..." }
        $statusLabel.Text = "Failed: $message"
        $statusLabel.ForeColor = [System.Drawing.Color]::Firebrick
        $saveButton.Enabled = $true
        $pasteButton.Enabled = $true
    } finally {
        Remove-Variable apiKey -ErrorAction SilentlyContinue
    }
})
$form.Controls.Add($saveButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Close"
$cancelButton.Location = New-Object System.Drawing.Point(448, 300)
$cancelButton.Size = New-Object System.Drawing.Size(78, 36)
$cancelButton.Add_Click({ $form.Close() })
$form.Controls.Add($cancelButton)

$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton
$form.Add_Shown({ $keyBox.Focus() })
[void]$form.ShowDialog()
