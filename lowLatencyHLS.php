<?php
/*
	File:  lowLatencyHLS.php

	Copyright 2018-2020 Apple Inc. All rights reserved.

	Permission is hereby granted, free of charge, to any person obtaining a copy 
	of this software and associated documentation files (the "Software"), to deal 
	in the Software without restriction, including without limitation the rights 
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies 
	of the Software, and to permit persons to whom the Software is furnished to 
	do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all 
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE 
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, 
	WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR 
	IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

$index_name = "prog_index.m3u8";		// cheesy

$tag_len = 0;

$ping_port = 0;		// set to non-zero to enable waitForIt to wait for a UDP ping to detect playlist modification

$requested_resource = "";
$target_duration = 0;
$playlist_duration = 0;
$part_hold_back = 0;

$server_control_tag = "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES";

function startsWith($haystack, $needle)
{
	global $tag_len;
	$tag_len = strlen($needle);
	return (substr($haystack, 0, $tag_len) === $needle);
}

function proper_parse_str($str) 
{
	$arr = array();			# result array
	$pairs = explode('&', $str);	# split on outer delimiter
	foreach ($pairs as $i) {		# loop through each pair
		if (strpos($i, "=") !== false) {
			list($name,$value) = explode('=', $i, 2);	# split into name and value
		
			if( isset($arr[$name]) ) {		# if name already exists
				if( is_array($arr[$name]) ) {
					$arr[$name][] = $value;		# stick multiple values into an array
				}
				else {
					$arr[$name] = array($arr[$name], $value);
				}
			}
			else {
				$arr[$name] = $value;		# otherwise, simply stick it in a scalar
			}
		}
	}
	return $arr;
}

class PlaylistReport
{
    public $playlist;
    public $duration;
	public $part_hold_back;
    public $last_seq_num;
    public $last_part_num;
    public $last_i_num;
    public $last_i_part;
    public $found;
    public $generated_report;
    public $error_code;
    public $error_description;
}

function getPlaylistAndLastSequenceAndPart($filename, $stash_seq_num, $stash_part)
// return PlaylistReport containing:
//		playlist, 
//		its duration in seconds,
//		sequence of last segment in playlist (even if partial)
//		last part (-1 if none), 
//		sequence of last segment containing an independent part (-1 if none), 
//		last independent part (-1 if none), 
// if stash_seq_num (and possibly stash_part) are not -1, set requested_resource to URL of that segment / part
{
	global $tag_len;
	global $requested_resource;
	global $target_duration;
	$working_seq_num = 0;
	$report = new PlaylistReport();
	$report->playlist = "";
	$report->last_seq_num = 0;
	$report->part_hold_back = 0;
	$this_part_num = -1;
	$report->last_part_num = -1;
	$report->last_i_num = -1;
	$report->last_i_part = -1;
    $report->found = false;
    $report->generated_report = "";
    $report->error_code = 200; // No error
    $report->error_description = "";

	if (file_exists($filename)) {
		$handle = @fopen($filename, "r");
		if ($handle) {
			$emit_next = false;
			while (($buffer = fgets($handle, 4096)) !== false) {
				$report->playlist = $report->playlist . $buffer; 

				if ( startsWith( $buffer, "#EXTINF:")) {
					$report->duration += substr($buffer, $tag_len, strpos($buffer, ",") - $tag_len - 1);
					$emit_next = true;
				}
				else if ( startsWith( $buffer, "#EXT-X-TARGETDURATION:")) {
					$target_duration = substr($buffer, $tag_len, strlen( $buffer) - $tag_len - 1);
				}
				else if ( startsWith( $buffer, "#EXT-X-MEDIA-SEQUENCE:")) {
					$working_seq_num = substr($buffer, $tag_len, strlen( $buffer) - $tag_len - 1);
				}
				else if ( startsWith( $buffer, "#EXT-X-PART-INF:PART-TARGET=")) {
					// PART-HOLD-BACK should be at least 3 times PART-TARGET
					$report->part_hold_back = 3 * substr($buffer, $tag_len, strlen( $buffer) - $tag_len - 1);
				}
				else if ( startsWith( $buffer, "#EXT-X-PART:")) {
					$this_part_num += 1;
					$report->last_part_num = $this_part_num;
					if (strpos($buffer, "INDEPENDENT=YES") !== false) {
						$report->last_i_num = $working_seq_num;
						$report->last_i_part = $this_part_num;
					}
					if ( $stash_part >= 0 && $report->found === false && $working_seq_num > $stash_seq_num) { // have complete parent segment without finding part; promote request to part 0 of next MSN
						 $stash_seq_num = $working_seq_num;	// set these up so that we pass the test below and select the current part
					 	 $stash_part = $this_part_num;
					}
					if ( $stash_part >= 0 && $this_part_num >= $stash_part && $working_seq_num == $stash_seq_num) {
						if ($this_part_num == $stash_part) {
							$url_delim = "URI=\"";
							$url_pos = strpos($buffer, $url_delim);
							$remainder = substr($buffer, $url_pos + strlen($url_delim));
							$trailer_pos = strpos($remainder, "\"");
							$requested_resource = substr($remainder, 0, $trailer_pos);
						}
						$report->found = true;		// report success even if requested part number is prior to everything in playlist
					}
				}
				else if ( strlen( $buffer) > 1 && !startsWith( $buffer, "#")) {			// non-empty non-comment line
					if ( $emit_next) {
						$this_part_num = -1;
						$emit_next = false;
						if ( ( $stash_part < 0 && $working_seq_num == $stash_seq_num) ||	// only match parent segment if no part was requested
							 ( $working_seq_num > $stash_seq_num)) {						// but make sure to match if an earlier MSN/part was requested
							if ( $working_seq_num == $stash_seq_num) {
								$requested_resource = substr($buffer, 0, strlen( $buffer) - 1);		// eat the linefeed
							}
							$report->found = true;
						}
						$working_seq_num += 1;
					}
				}
			}
			$report->last_seq_num = $working_seq_num - ($this_part_num == -1 ? 1 : 0);  // back up working_seq_num unless there are trailing partial segments
			fclose($handle);
		}
		else {
			$report->error_code = 500;
			$report->error_description = $report->error_description . "Index file for rendition report cannot be opened ". $filename . " ;";
		}
	}
	else {
		$report->error_code = 500;
		$report->error_description = $report->error_description . "Index file for requested rendition report does not exist ". $filename ." ;";
	}
	return $report;
}

function playlistHasSequenceNum($filename, $wait_seq_num, $wait_part)
// return playlist if it has >= $wait_seq_num.
// If wait_part >= 0, return playlist if it has that part of wait_seq_num.
{
	global $playlist_duration;
	global $part_hold_back;
	$report = getPlaylistAndLastSequenceAndPart($filename, $wait_seq_num, $wait_part);
	$playlist_duration = $report->duration;
	$part_hold_back = $report->part_hold_back;
	return $report->found ? $report->playlist : NULL;
}

function setupFileWait($filename)		// returns wait_token
{
	$wait_token = NULL;
	if (function_exists("inotify_init")) {
		$wait_token = inotify_init();
		inotify_add_watch($wait_token, $filename, IN_ALL_EVENTS);
	}
	return $wait_token;
}

function tearDownFileWait($wait_token)
{
	if (function_exists("inotify_init")) {
		fclose($wait_token);
	}
}

function waitForIt($wait_token)
{
	global $ping_port;
	if (function_exists("inotify_init")) {		// only available on Linux
		inotify_read($wait_token);
	}
	else if ($ping_port != 0) {
		$sock = stream_socket_server("udp://127.0.0.1:1339", $errno, $errstr, STREAM_SERVER_BIND);
		stream_socket_recvfrom($sock, 1);
		fclose($sock);
	}
	else {
		usleep( 5 * 1000);		// An efficient implmentation is left as an exercise to the reader.
	}
}

function waitForPlaylistWithSequenceNum($filename, $wait_seq_num, $part_param)
{
	$playlist = "";
	if(file_exists($filename)) {
		$wait_token = setupFileWait($filename);
	
		while (true) {
			$playlist = playlistHasSequenceNum($filename, $wait_seq_num, $part_param);
			if ( $playlist != NULL) {
				break;
			}
			waitForIt($wait_token);
		}

		tearDownFileWait($wait_token);
	}
	return $playlist;
}

function tagAppliesToSegment($line)
{
	return  startsWith( $line, "#EXT-X-DISCONTINUITY") ||
			startsWith( $line, "#EXT-X-GAP") ||
			startsWith( $line, "#EXT-X-PROGRAM-DATE-TIME:") ||
			startsWith( $line, "#EXT-X-BITRATE:") ||
			startsWith( $line, "#EXT-X-KEY:") ||
			startsWith( $line, "#EXT-X-BYTERANGE:");
}

function condensePlaylist($playlist, $time_to_skip)
{
	global $tag_len;
	$condensed_playlist = "";
	$examined = 0.0;
	$skip_count = 0;
	$unapplied_tags = "";

	$separator = "\n";
	$buffer = strtok($playlist, $separator);
	while ($buffer !== false) {
		if ( $examined < $time_to_skip && startsWith( $buffer, "#EXTINF:")) {
			$examined += substr($buffer, $tag_len, strpos($buffer, ",") - $tag_len - 1);
			if ($examined >= $time_to_skip) {
				$unapplied_tags = $unapplied_tags . $buffer . "\n";   // apply unapplied_tags and EXTINF
				$condensed_playlist = $condensed_playlist . "#EXT-X-SKIP:SKIPPED-SEGMENTS=" . $skip_count . "\n" . $unapplied_tags;
			}
			else {	// skip this tag and its URL line and applying tags
				$skip_count += 1;
			}
			$unapplied_tags = "";
		}
		else if ( startsWith( $buffer, "#EXT-X-VERSION:")) {	// force version to 9
			$condensed_playlist = $condensed_playlist .  "#EXT-X-VERSION:9\n";
		}
		else if ( $examined < $time_to_skip) {
			if ( tagAppliesToSegment( $buffer)) {
				$unapplied_tags = $unapplied_tags . $buffer . "\n";  // FIXME: not right if applied tag appears after EXTINF
			}
			else if ( startsWith( $buffer, "#")) {
				$condensed_playlist = $condensed_playlist . $buffer . "\n"; 
			}
		}
		else {
			$condensed_playlist = $condensed_playlist . $buffer . "\n"; 
		}
		$buffer = strtok( $separator);
	}
	return $condensed_playlist;
}

function makePlaylistWithBlockingInvocations($playlist)  // replace regular part URLs with blocking php invocation
{
	global $tag_len;
	$blockified_playlist = "";

	$separator = "\n";
	$buffer = strtok($playlist, $separator);
	while ($buffer !== false) {
		if ( startsWith( $buffer, "#EXT-X-PART:") || startsWith( $buffer, "#EXT-X-PRELOAD-HINT:")) {
			$script_name = basename(__FILE__);
			$url_attr = "URI=\"";
			$urlPos = strpos($buffer, $url_attr) + strlen($url_attr); 
			if ($urlPos !== false) {
				$blockified_playlist = $blockified_playlist . substr($buffer, 0, $urlPos) . $script_name . "?segment=" . substr($buffer, $urlPos) . "\n"; 
			}
			else {
				$blockified_playlist = $blockified_playlist . $buffer . "\n"; 
			}
		}
		else {
			$blockified_playlist = $blockified_playlist . $buffer . "\n"; 
		}
		$buffer = strtok( $separator);
	}
	return $blockified_playlist;
}

function playlistHasPartOrPreloadHint($filename, $segmentName)
{
	$has_part = false;
	$has_hint = false;
	$searchStr = "URI=\"" . $segmentName . "\"";

	if (file_exists($filename)) {
		$handle = @fopen($filename, "r");
		if ($handle) {
			while (($buffer = fgets($handle, 4096)) !== false) {
				if ( startsWith( $buffer, "#EXT-X-PART:") && strpos($buffer, $searchStr) !== false) {
					$has_part = true; 
					break;
				}
				else if ( startsWith( $buffer, "#EXT-X-PRELOAD-HINT:") && strpos($buffer, $searchStr) !== false) {
					$has_hint = true; 
				}
			}
			fclose($handle);
		}
	}
	return array($has_part, $has_hint);
}

function waitForPlaylistWithSegment($filename, $segmentName)
{
	$has_part = false;
	$has_hint = false;
	if(file_exists($filename)) {
		$wait_token = setupFileWait($filename);
		$start = time();
	
		while (true) {
			list($has_part, $has_hint) = playlistHasPartOrPreloadHint($filename, $segmentName);
			if ( $has_part || $has_hint === false) {  // URI must be either in a PART tag or still in the HINT tag.
				break;
			}
			if (time() > $start + 5) {
				break;
			}
			waitForIt($wait_token);
		}

		tearDownFileWait($wait_token);
	}
	return array($has_part, $has_hint);
}

function printUsageAndExit()
{
	$script_name = basename(__FILE__);
	header( "HTTP/2 400 Bad request", true, 400);
	echo "usage: $script_name?_HLS_msn=<n>[&_HLS_part=<m>][&_HLS_push=<0|1>][&_HLS_report=<uri>] \n";
	echo "e.g.: http://example.com/live/$script_name?_HLS_part=6&_HLS_part=3 \n";
	exit(0);
}

function real_user_path($path, $base_url)
{
	// A fairly hacky routine that can turn a path starting with /~username into a file path, if cwd also starts with /~
	$tildePos = strpos($path, "/~");
	$baseTildePos = strpos($base_url, "/~");
	if ($tildePos !== false && $baseTildePos !== false) {
		$how_far_down = substr_count( parse_url( $base_url, PHP_URL_PATH), "/", $baseTildePos + 1) - 1;
		$new_path = getcwd();
		for ( $i=0; $i < $how_far_down; $i++) {
			$new_path = $new_path . "/..";
		}
		$path = $new_path . substr( $path, strpos( $path, "/", $tildePos + 1));
	}
	else {	// assume that path is relative to document root
		$path = realpath( $_SERVER["DOCUMENT_ROOT"]) . $path;
	}
	return $path;
}

function emitReportForPath($base_url, $report_file_path, $report_url_path)
{
	$report = getPlaylistAndLastSequenceAndPart($report_file_path, -1, -1);
	if(($report->last_seq_num != -1) && ($report->last_part_num != -1)) {
		$report->generated_report = $report->generated_report . "#EXT-X-RENDITION-REPORT:URI=\"" . $report_url_path . "\"";
		if ($report->last_seq_num != -1) {
			$report->generated_report = $report->generated_report . ",LAST-MSN=" . $report->last_seq_num;
		}
		if ($report->last_part_num != -1) {
			$report->generated_report = $report->generated_report . ",LAST-PART=" . $report->last_part_num;
		}
		if ($report->last_i_num != -1) {
			$report->generated_report = $report->generated_report . ",LAST-I-MSN=" . $report->last_i_num;
		}
		if ($report->last_i_part != -1) {
			$report->generated_report = $report->generated_report . ",LAST-I-PART=" . $report->last_i_part;
		}
		$report->generated_report = $report->generated_report . "\n";
	}
	else {
		$report->error_code = 500;
		$report->error_description = $report->error_description . "Rendition report generation failed - file:". $report_file_path . " ;";
	}
	return $report;
}

function emitReportForURL($base_url, $report_url_path, $playlist_filename)
{
	// turn path containing ~ into a filesystem path
	$report_file_path = real_user_path($report_url_path, $base_url);

	// hack: if client specifies this script in its rendition URL, use the underlying playlist instead
	$thisName = basename( parse_url( $base_url, PHP_URL_PATH));
	$report_file_path = str_replace( $thisName, $playlist_filename, $report_file_path);

	return emitReportForPath( $base_url, $report_file_path, $playlist_filename);
}

function emitReportsForURL($active_url, $playlist_filename)
// scan through peer directories looking for other renditions, i.e. peer directories containing same playlist filename <cheesy/>
{
	$report_lines = "";
	$unreported = "";
	$result = 200;
	$error_description = "";
	$url_path = parse_url($active_url, PHP_URL_PATH);
	$active_path = real_user_path( $active_url, $url_path);
	$parent = realpath(dirname( $active_path));
	$grandpa = dirname( $parent) . "/";
	if ($handle = opendir($grandpa)) {
		$grandpa_url_path = dirname( dirname( $url_path));  // used to form path that goes into rendition report
		if (substr($grandpa_url_path, -1) != "/") {
			$grandpa_url_path = $grandpa_url_path . "/";
		}
		$scriptName = basename( $url_path);
		while (false !== ($entry = readdir($handle))) {
			if ($entry != ".." && $entry != ".") {
				$entry_path = $grandpa . $entry ;
				$putative_playlist = $entry_path . "/" . $playlist_filename;
				if ( $entry_path != $parent && is_dir( $entry_path)) {
					if ( file_exists($putative_playlist)) {
						$report_url_path = $grandpa_url_path . $entry . "/" . $playlist_filename;
						// hack: if client specifies this script in its rendition URL, use it instead of actual playlist name
						$report_url_path = str_replace( $playlist_filename, $scriptName, $report_url_path);
						$requested_report = emitReportForPath($active_url, $putative_playlist, $report_url_path);
						$result = $requested_report->error_code;
						if( $result == 200) {
							// report was generated successfully
							$report_lines = $report_lines . $requested_report->generated_report;
						}
						else {
							$error_description = $requested_report->error_description;
							break;
						}
					}
					else {
						$unreported = $unreported . " " . $entry;
					}
				}
			}
		}
	}
	if ( $unreported != "") {
		$report_lines = $report_lines . "# Rendition Reports not created for" . $unreported . "\n";
	}
	return array($report_lines, $result, $error_description);
}

$url =  $_SERVER['REQUEST_URI'];
$query_string = parse_url($url, PHP_URL_QUERY);
$query_params = proper_parse_str($query_string);

$segment_param = array_key_exists('segment', $query_params) ? $query_params['segment'] : null;
if ( $segment_param != null) {
	header("Cache-Control: max-age=10");
	list($has_part, $has_hint) = waitForPlaylistWithSegment( $index_name, $segment_param);
	if ( $has_part) {
		header("Content-Type: " . mime_content_type($segment_param));
		header("Content-Length: " . filesize($segment_param));
		readfile($segment_param);  // fixme: handle byte ranges
	}
	else if ($has_hint === false) {
 		header( "HTTP/2 404 Not found", true, 404);
	}
	else {
 		header( "HTTP/2 500 Internal Server Error", true, 500);
	}
	return;
}

header("Content-Type: application/vnd.apple.mpegurl");

$report = NULL;
$generated_report = NULL;
$error_report = NULL;
$http_code = 200;
$can_skip = 0;

$seq_param = array_key_exists('_HLS_msn', $query_params) ? $query_params['_HLS_msn'] : null;
$part_param = array_key_exists('_HLS_part', $query_params) ? $query_params['_HLS_part'] : -1;
$push_param = array_key_exists('_HLS_push', $query_params) ? $query_params['_HLS_push'] : 0;
$skip_param = array_key_exists('_HLS_skip', $query_params) ? $query_params['_HLS_skip'] : 0;

if ( $seq_param != null) {
	$playlist = waitForPlaylistWithSequenceNum( $index_name, $seq_param, $part_param);
	
	if( $playlist_duration > 7 * $target_duration) {
		$can_skip = 1;
	}

	if( $playlist != NULL ) {
		header('Expires: '.gmdate('D, d M Y H:i:s \G\M\T', time() + (2 * 60))); // 2 minutes
		if ( $push_param > 0 && $requested_resource != "") {			// To be deleted once we transition away from Push
			header("Link: <" . dirname( parse_url($url, PHP_URL_PATH)) . "/" . $requested_resource . ">; rel=preload; as=video; type=video/mp2t");
		}
		if ($skip_param === "YES" && $can_skip == 1) {
			$playlist = condensePlaylist($playlist,  $playlist_duration - 6 * $target_duration);
		}
		$playlist = makePlaylistWithBlockingInvocations($playlist);
		if( $can_skip == 1) {
			$server_control_tag = $server_control_tag . ",CAN-SKIP-UNTIL=". 6 * $target_duration;
		}
		$playlist = $playlist . $server_control_tag . ",PART-HOLD-BACK=" . $part_hold_back . "\n";
		echo $playlist;
		
	//	echo "# seq-num " . $seq_param . " / part " . $part_param . " is " . $requested_resource . "\n";
	}
	else {
		$http_code = 500;
		header( "HTTP/2 ". $http_code . " Internal Server Error", true, $http_code);
		header( "X-Error-Description: Check index file ". $index_name . ",requested sequence num " . $seq_param . " or part num " . $part_param);
	}
}
else {
	if ( file_exists($index_name)) {
		header("Cache-Control: max-age=2");
		$playlist = playlistHasSequenceNum($index_name, 0, 0);
		
		if( $playlist_duration > 7 * $target_duration) {
			$can_skip = 1;
		}

		if ($skip_param === "YES" && $can_skip == 1) {
			$playlist = condensePlaylist($playlist,  $playlist_duration - 6 * $target_duration);
		}
		$playlist = makePlaylistWithBlockingInvocations($playlist);
		if( $can_skip == 1) {
			$server_control_tag = $server_control_tag . ",CAN-SKIP-UNTIL=". 6 * $target_duration;
		}
		$playlist = $playlist . $server_control_tag . ",PART-HOLD-BACK=" . $part_hold_back . "\n";
		echo $playlist;
	}
	else {
		$http_code = 500;
		header( "HTTP/2 ". $http_code . " Internal Server Error", true, $http_code);
		header( "X-Error-Description: Index file ". $index_name . " does not exist");
	}
}

if ($http_code == 200) {
	// Generate reports on other renditions
	list($report, $http_code, $error_report) = emitReportsForURL($url, $index_name);
	if( ($report != NULL) && ($http_code == 200) ) { // HTTP code should be 200 if the report was generated, but just in case
		//echo表示要返回给客户端的内容
		echo $report;
	}
	else {
		header( "HTTP/2 " . $http_code . " Internal Server Error", true, 500); // To Do: Update based on new error codes as they are added.
		if( $error_report != NULL ) {
			header( "X-Error-Description: ". $error_report );
		}
		else {
		//不管有几个header，php会最终执行最后一个header
			header( "X-Error-Description: Unknown error - error report not generated");
		}
	}
}

?>
