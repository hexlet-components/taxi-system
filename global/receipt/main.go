package main

import "fmt"

func main() {
	requiredVersion := 6
	for _, visibleVersion := range []int{5, 6, 7} {
		if visibleVersion < requiredVersion {
			fmt.Println("ждать")
		} else {
			fmt.Println("готово")
		}
	}
}
